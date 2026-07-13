import { auth } from '@/auth';

/**
 * FE-030 — gate the operator surface. Unauthenticated hits to `/dashboard` or
 * `/settings` bounce to `/sign-in`; the auth pages and NextAuth routes stay
 * open. (Fine-grained step-up + role checks live on the API, BE-036/037.)
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const gated = pathname.startsWith('/dashboard') || pathname.startsWith('/settings');
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
