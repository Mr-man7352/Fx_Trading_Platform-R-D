'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@fx/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

/** FE-034 — post-registration "check your email" state. */
function Pending() {
  const email = useSearchParams().get('email');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
        <CardDescription>
          We sent a verification link{email ? ` to ${email}` : ''}. Click it to activate your
          account, then sign in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>In development the link is printed to the API server logs (Resend is optional).</p>
        <Link href="/sign-in" className="text-primary hover:underline">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}

export default function VerifyPendingPage() {
  return (
    <Suspense>
      <Pending />
    </Suspense>
  );
}
