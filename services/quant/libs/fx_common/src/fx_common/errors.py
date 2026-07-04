"""FXError — base error with a stable machine-readable code (QN-002).

`to_dict()` matches the `ApiError` contract in `@fx/types` so REST error
responses are shaped identically across Node and Python services.
"""

from __future__ import annotations


class FXError(Exception):
    """Base exception for FX Python services."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: list[dict[str, str]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or []

    def to_dict(self) -> dict[str, object]:
        """Serialize to the `@fx/types` ApiError envelope."""
        error: dict[str, object] = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return {"error": error}

    def __repr__(self) -> str:
        return f"FXError(code={self.code!r}, message={self.message!r})"
