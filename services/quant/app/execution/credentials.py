"""BE-131 (Python side) — broker credential envelope decrypt + DB loader.

First real consumer of the sealed credentials (QN-032 OANDA execution adapter).
Wire format is EXACTLY what the Node sealer writes
(`apis/node-api/src/crypto/credentials.ts`):

    "v1:" + base64( iv[12] ‖ authTag[16] ‖ ciphertext )
    AAD       = "fx-broker-credentials:v1"
    plaintext = UTF-8 JSON {"apiToken": …, "accountId": …, …}
    key       = CREDENTIALS_ENCRYPTION_KEY env — base64 of exactly 32 bytes

`cryptography`'s AESGCM wants tag APPENDED to ciphertext, so we re-order.
Round-trip parity with the Node sealer is pinned by test_credentials.py using
an envelope sealed by the TS implementation.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

if TYPE_CHECKING:
    import asyncpg

_VERSION = "v1"
_AAD = f"fx-broker-credentials:{_VERSION}".encode()
_IV_LEN = 12
_TAG_LEN = 16


class CredentialError(RuntimeError):
    """Bad key, unsupported version, truncated/tampered envelope, or no DB row."""


@dataclass(frozen=True, slots=True)
class BrokerCredentials:
    """Decrypted payload (opaque extras preserved in `raw`)."""

    api_token: str
    account_id: str
    raw: dict[str, Any]


def parse_encryption_key(base64_key: str) -> bytes:
    """Mirror of the Node `parseEncryptionKey` — base64 of exactly 32 bytes."""
    try:
        key = base64.b64decode(base64_key, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CredentialError("CREDENTIALS_ENCRYPTION_KEY is not valid base64") from exc
    if len(key) != 32:
        raise CredentialError(
            f"CREDENTIALS_ENCRYPTION_KEY must be base64 of exactly 32 bytes (got {len(key)}). "
            "Generate one with: openssl rand -base64 32"
        )
    return key


def open_credentials(envelope: str, key: bytes) -> BrokerCredentials:
    """Decrypt a sealed envelope; raises CredentialError on any failure."""
    version, sep, body = envelope.partition(":")
    if version != _VERSION or not sep or not body:
        raise CredentialError(f"Unsupported credential envelope version: {version or '(none)'}")
    try:
        buf = base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CredentialError("Credential envelope is not valid base64") from exc
    if len(buf) < _IV_LEN + _TAG_LEN + 1:
        raise CredentialError("Credential envelope is truncated")
    iv = buf[:_IV_LEN]
    tag = buf[_IV_LEN : _IV_LEN + _TAG_LEN]
    ciphertext = buf[_IV_LEN + _TAG_LEN :]
    try:
        # AESGCM wants tag appended: ct ‖ tag (envelope stores iv ‖ tag ‖ ct).
        plaintext = AESGCM(key).decrypt(iv, ciphertext + tag, _AAD)
    except InvalidTag as exc:
        raise CredentialError("Credential envelope failed authentication (wrong key?)") from exc
    payload: dict[str, Any] = json.loads(plaintext.decode("utf-8"))
    try:
        return BrokerCredentials(
            api_token=str(payload["apiToken"]),
            account_id=str(payload["accountId"]),
            raw=payload,
        )
    except KeyError as exc:
        raise CredentialError(f"Credential payload missing field: {exc}") from exc


async def load_broker_credentials(
    conn: asyncpg.Connection,
    *,
    key: bytes,
    broker: str = "oanda",
    environment: str = "practice",
    label: str = "default",
) -> BrokerCredentials:
    """Fetch + decrypt the newest matching `broker_credentials` row (seeded by
    `pnpm seed:creds` until the Phase-5 settings write path lands)."""
    row = await conn.fetchrow(
        """
        select ciphertext from broker_credentials
        where broker = $1 and environment = $2 and label = $3
        order by updated_at desc limit 1
        """,
        broker,
        environment,
        label,
    )
    if row is None:
        raise CredentialError(
            f"no broker_credentials row for {broker}/{environment}/{label} — run `pnpm seed:creds`"
        )
    creds = open_credentials(row["ciphertext"], key)
    await conn.execute(
        "update broker_credentials set last_used_at = now() where ciphertext = $1",
        row["ciphertext"],
    )
    return creds
