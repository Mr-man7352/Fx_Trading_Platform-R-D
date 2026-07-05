import type { ComponentProps } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/alert';
import { cn } from '../lib/cn';

/**
 * FE-110 (Phase-1 part) — persistent CFD risk disclaimer for trading views.
 * Ships in `packages/ui` now; attaches to the dashboard shell when FE-040
 * lands (no hard dependency on the shell). The one-time acknowledgement flow
 * (`users.disclaimer_accepted_at`) arrives with auth in Phase 5.
 */
export const DISCLAIMER_TEXT =
  'Research and educational tool — not financial advice. CFDs are complex, leveraged ' +
  'instruments and carry a high risk of rapid loss. Trade only on your own account and ' +
  'only with capital you can afford to lose.';

export function DisclaimerBanner({ className, ...props }: ComponentProps<'div'>) {
  return (
    <Alert variant="warning" className={cn('rounded-none border-x-0 py-2', className)} {...props}>
      <AlertTitle className="sr-only">Risk warning</AlertTitle>
      <AlertDescription className="text-xs">{DISCLAIMER_TEXT}</AlertDescription>
    </Alert>
  );
}
