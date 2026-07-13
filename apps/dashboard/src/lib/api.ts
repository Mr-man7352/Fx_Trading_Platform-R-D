'use client';

import { createApiClient } from '@fx/api-client';
import { useStepUpStore } from '@/stores/step-up';
import { API_BASE_URL } from './api-base';

/**
 * FE-005 — the browser-side typed API client. Authenticated calls carry a
 * short-lived HS256 bearer minted server-side at `/api/token` (BE-030); 401
 * bounces to `/sign-in`, and a 403 `STEP_UP_2FA_REQUIRED` opens the global
 * step-up modal (FE-035). Runtime Zod validation lives in `@fx/api-client`.
 */
async function mintedBearer(): Promise<string | undefined> {
  const res = await fetch('/api/token', { cache: 'no-store' });
  if (!res.ok) return undefined;
  const { token } = (await res.json()) as { token?: string };
  return token;
}

export const api = createApiClient({
  baseUrl: API_BASE_URL,
  getToken: mintedBearer,
  onUnauthorized: () => {
    if (typeof window !== 'undefined') {
      const { pathname } = window.location;
      window.location.href = `/sign-in?callbackUrl=${encodeURIComponent(pathname)}`;
    }
  },
  onStepUpRequired: () => useStepUpStore.getState().require(),
});
