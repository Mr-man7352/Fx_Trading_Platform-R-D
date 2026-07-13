/**
 * FE-030…036 — the dashboard talks to the Node API over REST. Public auth
 * endpoints (register/verify/reset) are called straight from the browser (CORS
 * allows localhost:3000); authenticated endpoints go through the api-client with
 * a short-lived bearer minted by `/api/token`.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
