'use client';

import { Alert, AlertDescription, Button, Input, Label } from '@fx/ui';
import { useState } from 'react';
import { AuthApiError, enroll2faStart, enroll2faVerify } from '@/lib/auth-api';

type Phase = 'idle' | 'started' | 'done';

/**
 * FE-035 — TOTP enrollment: start → scan/paste secret → verify a code → the API
 * returns 10 single-use recovery codes, shown exactly once (BE-036).
 */
export function TwoFactorEnroll({ onEnabled }: { onEnabled: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await enroll2faStart();
      setSecret(res.secret);
      setOtpauthUrl(res.otpauthUrl);
      setPhase('started');
    } catch (err) {
      setError(
        err instanceof AuthApiError && err.code === 'TWO_FACTOR_ALREADY_ENABLED'
          ? 'Two-factor is already enabled.'
          : 'Could not start enrollment.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await enroll2faVerify(code.trim());
      setRecoveryCodes(res.recoveryCodes);
      setPhase('done');
    } catch {
      setError('That code was not valid. Check your authenticator and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'done') {
    return (
      <div className="space-y-3">
        <Alert variant="warning">
          <AlertDescription>
            Save these 10 recovery codes now — each works once and they won't be shown again.
          </AlertDescription>
        </Alert>
        <ul className="grid grid-cols-2 gap-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button
          onClick={() => {
            setPhase('idle');
            onEnabled();
          }}
        >
          I've saved my recovery codes
        </Button>
      </div>
    );
  }

  if (phase === 'started') {
    return (
      <form onSubmit={verify} className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">
          Add this account to your authenticator app, then enter the current code.
        </p>
        <div className="space-y-1">
          <Label>Secret key</Label>
          <code className="block break-all rounded-md border bg-muted/40 p-2 font-mono text-sm">
            {secret}
          </code>
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Show otpauth URL</summary>
          <code className="mt-1 block break-all">{otpauthUrl}</code>
        </details>
        <div className="space-y-1.5">
          <Label htmlFor="enroll-code">6-digit code</Label>
          <Input
            id="enroll-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
          />
        </div>
        <Button type="submit" disabled={busy || code.trim().length !== 6}>
          {busy ? 'Verifying…' : 'Enable two-factor'}
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        Protect the kill-switch and live-mode changes with a time-based one-time code.
      </p>
      <Button onClick={start} disabled={busy}>
        {busy ? 'Starting…' : 'Set up two-factor'}
      </Button>
    </div>
  );
}
