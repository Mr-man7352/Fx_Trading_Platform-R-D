import { auth } from '@/auth';

/**
 * FE-030/FE-041 — gate the operator surface. The dashboard pages live in the
 * `(dashboard)` route group, which resolves to top-level paths, so every
 * operator route is listed here. Unauthenticated hits bounce to `/sign-in`; the
 * auth pages and NextAuth routes stay open. (Fine-grained step-up + role checks
 * live on the API, BE-036/037.)
 */
const GATED_PREFIXES = [
  '/dashboard',
  '/settings',
  '/charts',
  '/agents',
  '/trades',
  '/backtest',
  '/quant',
  '/calendar',
  '/audit',
];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const gated = GATED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (gated && !req.auth) {
    const url = new URL('/sign-in', req.nextUrl.origin);
    url.searchParams.set('callbackUrl', pathname);
    return Response.redirect(url);
  }
});

export const config = {
  // Skip API routes (incl. NextAuth + /api/token), Next internals, static assets.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
