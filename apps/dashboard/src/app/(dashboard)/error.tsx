'use client';

import { Alert, AlertDescription, AlertTitle, Button } from '@fx/ui';
import { useEffect } from 'react';

/**
 * FE-121 — route-segment error boundary for every dashboard page. Calm copy,
 * a visible digest id (Next.js's server-side error correlation id — pairs
 * with request ids in the audit log), and a retry affordance. Never a blank
 * screen, never a stack trace in the operator's face.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard] route error boundary:', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-10">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong on this page</AlertTitle>
        <AlertDescription>
          The rest of the dashboard is unaffected — trading safety controls (kill-switch) stay
          available in the header. Try again, and if it persists check the audit log around this
          time.
          {error.digest && (
            <span className="mt-2 block font-mono text-xs text-muted-foreground">
              error digest: {error.digest}
            </span>
          )}
        </AlertDescription>
      </Alert>
      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={reset}>
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.assign('/dashboard')}>
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
