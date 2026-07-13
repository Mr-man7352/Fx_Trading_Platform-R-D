'use client';

import { useStepUpStore } from '@/stores/step-up';
import { StepUpModal } from './step-up-modal';

/**
 * FE-035 — mounted once in the dashboard layout. Any API 403
 * `STEP_UP_2FA_REQUIRED` flips the step-up store open (see `lib/api.ts`); on a
 * successful verify the session's `stepUp2FAAt` refreshes and callers can retry.
 */
export function StepUpGate() {
  const { open, setOpen, resolve } = useStepUpStore();
  return <StepUpModal open={open} onOpenChange={setOpen} onVerified={resolve} />;
}
