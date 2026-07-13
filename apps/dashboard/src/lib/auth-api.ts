'use client';

import {
  type AccountResponse,
  AccountResponseSchema,
  AuthOkResponseSchema,
  type RegisterResponse,
  RegisterResponseSchema,
  type TwoFactorEnrollCompleteResponse,
  TwoFactorEnrollCompleteResponseSchema,
  type TwoFactorEnrollStartResponse,
  TwoFactorEnrollStartResponseSchema,
  type TwoFactorStatusResponse,
  TwoFactorStatusResponseSchema,
  type TwoFactorVerifyResponse,
  TwoFactorVerifyResponseSchema,
} from '@fx/types';
import { API_BASE_URL } from './api-base';

// Re-export the response types consumers pull from this module (FE-036).
export type { AccountResponse } from '@fx/types';

/**
 * Minimal structural view of a zod schema — just what these helpers use
 * (`.parse` + its inferred output). Avoids a direct `zod` dependency in the
 * dashboard; the schemas come from `@fx/types`, which owns zod.
 */
type SchemaLike<T> = { parse: (data: unknown) => T };

/** Thrown on any non-2xx; carries the API error code for UI branching. */
export class AuthApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

async function unwrap<T>(schema: SchemaLike<T>, res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = body?.error?.code ?? 'UNKNOWN';
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    throw new AuthApiError(code, message, res.status);
  }
  return schema.parse(await res.json());
}

/** Fetch a fresh API bearer minted for the current session (server-side). */
async function bearer(): Promise<string> {
  const res = await fetch('/api/token', { cache: 'no-store' });
  if (!res.ok) throw new AuthApiError('UNAUTHORIZED', 'Not authenticated', 401);
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function authed<T>(schema: SchemaLike<T>, path: string, init: RequestInit = {}): Promise<T> {
  const token = await bearer();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  return unwrap(schema, res);
}

async function pub<T>(schema: SchemaLike<T>, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  return unwrap(schema, res);
}

// ── Public flows (no bearer) ─────────────────────────────────────────────────

export function register(input: {
  email: string;
  password: string;
  inviteCode: string;
  name?: string;
}): Promise<RegisterResponse> {
  return pub(RegisterResponseSchema, '/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function requestPasswordReset(email: string): Promise<void> {
  return pub(AuthOkResponseSchema, '/auth/request-password-reset', {
    method: 'POST',
    body: JSON.stringify({ email }),
  }).then(() => undefined);
}

export function resetPassword(token: string, password: string): Promise<void> {
  return pub(AuthOkResponseSchema, '/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  }).then(() => undefined);
}

export function verifyEmail(token: string): Promise<void> {
  return pub(AuthOkResponseSchema, `/auth/verify?token=${encodeURIComponent(token)}`).then(
    () => undefined,
  );
}

// ── Authenticated flows (bearer) ─────────────────────────────────────────────

export function getAccount(): Promise<AccountResponse> {
  return authed(AccountResponseSchema, '/auth/account');
}

export function changePassword(input: {
  currentPassword?: string;
  newPassword: string;
}): Promise<void> {
  return authed(AuthOkResponseSchema, '/auth/account/change-password', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then(() => undefined);
}

export function twoFactorStatus(): Promise<TwoFactorStatusResponse> {
  return authed(TwoFactorStatusResponseSchema, '/auth/2fa/status');
}

export function enroll2faStart(): Promise<TwoFactorEnrollStartResponse> {
  return authed(TwoFactorEnrollStartResponseSchema, '/auth/2fa/enroll', { method: 'POST' });
}

export function enroll2faVerify(code: string): Promise<TwoFactorEnrollCompleteResponse> {
  return authed(TwoFactorEnrollCompleteResponseSchema, '/auth/2fa/enroll/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function stepUpVerify(code: string): Promise<TwoFactorVerifyResponse> {
  return authed(TwoFactorVerifyResponseSchema, '/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}
