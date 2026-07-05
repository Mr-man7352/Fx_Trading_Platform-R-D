'use client';

import { type FormEvent, useCallback, useState } from 'react';
import { Button } from '../components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/dialog';
import { Input } from '../components/input';
import { Label } from '../components/label';
import { cn } from '../lib/cn';

/**
 * FE-011 — <KillSwitchButton>: red, always-reachable emergency stop.
 *
 * Phase-1 scope: presentational + confirmation dialog. The step-up 2FA seam is
 * `requireTwoFactorCode` + the `twoFactorCode` argument to `onConfirm` — Phase 5
 * (FE-033/BE-032) turns the flag on and verifies the code server-side; the
 * component contract does not change. `compact` renders the one-tap icon
 * variant for the mobile sticky footer (FE-130).
 */
export interface KillSwitchButtonProps {
  /** Called when the operator confirms. Throwing keeps the dialog open with the error. */
  onConfirm: (args: { twoFactorCode?: string }) => Promise<void> | void;
  /** Phase 5: set true to demand a step-up 2FA code before confirming. */
  requireTwoFactorCode?: boolean;
  /** Icon-only variant for the mobile nav / sticky footer. */
  compact?: boolean;
  /** Disable while a halt is already in flight or the platform is already halted. */
  disabled?: boolean;
  className?: string;
}

export function KillSwitchButton({
  onConfirm,
  requireTwoFactorCode = false,
  compact = false,
  disabled = false,
  className,
}: KillSwitchButtonProps) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setCode('');
      setError(null);
      setPending(false);
    }
  }, []);

  const handleConfirm = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (requireTwoFactorCode && code.trim().length === 0) {
        setError('Enter your 2FA code to confirm.');
        return;
      }
      setPending(true);
      setError(null);
      try {
        await onConfirm(requireTwoFactorCode ? { twoFactorCode: code.trim() } : {});
        setOpen(false);
        setCode('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Kill switch failed — retry immediately.');
      } finally {
        setPending(false);
      }
    },
    [code, onConfirm, requireTwoFactorCode],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="destructive"
          size={compact ? 'icon' : 'default'}
          disabled={disabled}
          aria-label="Kill switch — halt all trading"
          className={cn('font-bold', className)}
        >
          {/* Inline octagon-stop icon — no icon-library dependency in Phase 1. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          >
            <path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z" />
            <path d="M9 9.5h6v5H9z" fill="currentColor" stroke="none" />
          </svg>
          {!compact && 'KILL SWITCH'}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-destructive/50">
        <DialogHeader>
          <DialogTitle className="text-destructive">Halt all trading?</DialogTitle>
          <DialogDescription>
            Cancels every working order, blocks new entries, and flattens per the halt policy.
            Positions may close at market. This action is audited.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleConfirm} className="grid gap-4">
          {requireTwoFactorCode && (
            <div className="grid gap-2">
              <Label htmlFor="kill-switch-2fa">Step-up 2FA code</Label>
              <Input
                id="kill-switch-2fa"
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending} className="font-bold">
              {pending ? 'Halting…' : 'Confirm halt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
