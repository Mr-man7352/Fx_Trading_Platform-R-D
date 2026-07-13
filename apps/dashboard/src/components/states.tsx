import { Alert, AlertDescription, AlertTitle, Skeleton } from '@fx/ui';
import type { ReactNode } from 'react';

/**
 * FE-121 — calm, uniform empty/error/loading states. Never a blank screen; API
 * errors surface a request id where we have one so failures stay debuggable.
 */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const requestId =
    error && typeof error === 'object' && 'requestId' in error
      ? (error as { requestId?: string }).requestId
      : undefined;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined;
  const unavailable = code === 'DB_UNAVAILABLE' || code === 'KILL_SWITCH_UNAVAILABLE';
  return (
    <Alert variant={unavailable ? 'default' : 'destructive'}>
      <AlertTitle>{unavailable ? 'Not available yet' : 'Could not load'}</AlertTitle>
      <AlertDescription>
        {unavailable
          ? 'This surface needs a backend seam that is not wired on this instance yet.'
          : message}
        {requestId && (
          <span className="mt-1 block font-mono text-xs text-muted-foreground">
            request id: {requestId}
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholder
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
