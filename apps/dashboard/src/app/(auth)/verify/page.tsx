'use client';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@fx/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { verifyEmail } from '@/lib/auth-api';

type State = 'verifying' | 'ok' | 'error';

/** FE-034 — completes email verification from the link token. */
function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<State>('verifying');

  useEffect(() => {
    if (!token) {
      setState('error');
      return;
    }
    verifyEmail(token).then(
      () => setState('ok'),
      () => setState('error'),
    );
  }, [token]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {state === 'verifying'
            ? 'Verifying…'
            : state === 'ok'
              ? 'Email verified'
              : 'Verification failed'}
        </CardTitle>
        <CardDescription>
          {state === 'ok'
            ? 'Your email is verified. You can sign in now.'
            : state === 'error'
              ? 'This link is invalid or has expired. Request a new one by signing in.'
              : 'Please wait a moment.'}
        </CardDescription>
      </CardHeader>
      {state !== 'verifying' && (
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/sign-in">Go to sign in</Link>
          </Button>
        </CardContent>
      )}
    </Card>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
