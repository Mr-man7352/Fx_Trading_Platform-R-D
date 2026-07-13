import { create } from 'zustand';

/**
 * FE-005/FE-035 — global step-up 2FA gate. The api-client calls `require()` when
 * the API answers 403 `STEP_UP_2FA_REQUIRED`; `<StepUpGate>` (rendered once in
 * the dashboard layout) subscribes and opens the modal. `resolve()` fires after
 * a successful verify so the caller can retry.
 */
interface StepUpState {
  open: boolean;
  /** Set after a successful step-up so pending callers can react. */
  lastVerifiedAt: number | null;
  require: () => void;
  setOpen: (open: boolean) => void;
  resolve: () => void;
}

export const useStepUpStore = create<StepUpState>((set) => ({
  open: false,
  lastVerifiedAt: null,
  require: () => set({ open: true }),
  setOpen: (open) => set({ open }),
  resolve: () => set({ open: false, lastVerifiedAt: Date.now() }),
}));
