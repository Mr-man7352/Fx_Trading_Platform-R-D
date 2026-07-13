'use client';

import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@fx/ui';
import { useSession } from 'next-auth/react';
import { useState } from 'react';
import { AuthApiError, stepUpVerify } from '@/lib/auth-api';

/**
 * FE-035 — step-up 2FA modal. Verifies a TOTP or recovery code, then refreshes
 * the session's `stepUp2FAAt` so subsequent sensitive calls carry a fresh claim
 * (the API enforces the 15-min window, BE-036).
 */
export function StepUpModal({
  open,
  onOpenChange,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
}) {
  const { update } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await stepUpVerify(code.trim());
      await update({ stepUp2FAAt: res.stepUp2FAAt });
      setCode('');
      onOpenChange(false);
      onVerified();
    } catch (err) {
      setError(
        err instanceof AuthApiError && err.code === 'TWO_FACTOR_NOT_ENROLLED'
          ? 'Enable two-factor authentication first.'
          : 'That code was not valid. Try again or use a recovery code.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>
            Enter the 6-digit code from your authenticator app, or a recovery code.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="stepup-code">Code</Label>
            <Input
              id="stepup-code"
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
