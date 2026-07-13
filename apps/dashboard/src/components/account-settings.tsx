'use client';

import { STEP_UP_MAX_AGE_MS } from '@fx/types';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@fx/ui';
import { signIn, useSession } from 'next-auth/react';
import { useCallback, useEffect, useState } from 'react';
import { type AccountResponse, changePassword, getAccount, twoFactorStatus } from '@/lib/auth-api';
import { StepUpModal } from './step-up-modal';
import { TwoFactorEnroll } from './two-factor-enroll';

/** FE-036 — account settings: profile, Google linking, password, and 2FA. */
export function AccountSettings() {
  const { data: session } = useSession();
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [recoveryRemaining, setRecoveryRemaining] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(() => {
    getAccount().then(setAccount, () => setLoadError(true));
    twoFactorStatus().then(
      (s) => setRecoveryRemaining(s.enabled ? s.recoveryCodesRemaining : null),
      () => undefined,
    );
  }, []);

  useEffect(reload, [reload]);

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load your account. Is the API running?</AlertDescription>
      </Alert>
    );
  }
  if (!account) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>{account.email}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Name" value={account.name ?? '—'} />
          <Row label="Role" value={<Badge>{account.role}</Badge>} />
          <Row
            label="Email verified"
            value={
              account.emailVerified ? <Badge>Verified</Badge> : <Badge variant="outline">No</Badge>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sign-in methods</CardTitle>
          <CardDescription>Link Google to sign in either way (BE-037).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row
            label="Password"
            value={
              account.passwordSet ? <Badge>Set</Badge> : <Badge variant="outline">Not set</Badge>
            }
          />
          <Row
            label="Google"
            value={
              account.googleLinked ? (
                <Badge>Linked</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => signIn('google')}>
                  Link Google
                </Button>
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>Required for the kill-switch and live-mode changes.</CardDescription>
        </CardHeader>
        <CardContent>
          {account.twoFactorEnabled ? (
            <div className="space-y-1 text-sm">
              <Badge>Enabled</Badge>
              {recoveryRemaining !== null && (
                <p className="text-muted-foreground">
                  {recoveryRemaining} recovery code{recoveryRemaining === 1 ? '' : 's'} remaining.
                </p>
              )}
            </div>
          ) : (
            <TwoFactorEnroll onEnabled={reload} />
          )}
        </CardContent>
      </Card>

      <ChangePasswordCard account={account} session={session} onChanged={reload} />
    </div>
  );
}

function ChangePasswordCard({
  account,
  session,
  onChanged,
}: {
  account: AccountResponse;
  session: ReturnType<typeof useSession>['data'];
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [showStepUp, setShowStepUp] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const at = session?.stepUp2FAAt ? new Date(session.stepUp2FAAt).getTime() : null;
  const stale = at === null || Number.isNaN(at) || Date.now() - at > STEP_UP_MAX_AGE_MS;

  function begin() {
    setOk(false);
    setError(null);
    if (stale) setShowStepUp(true);
    else setShowForm(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changePassword({
        currentPassword: account.passwordSet ? current : undefined,
        newPassword: next,
      });
      setOk(true);
      setShowForm(false);
      setCurrent('');
      setNext('');
      onChanged();
    } catch {
      setError('Could not update password. Check your current password and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{account.passwordSet ? 'Change password' : 'Set a password'}</CardTitle>
        <CardDescription>Requires a step-up 2FA check.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ok && (
          <Alert>
            <AlertDescription>Password updated.</AlertDescription>
          </Alert>
        )}
        {!account.twoFactorEnabled ? (
          <p className="text-sm text-muted-foreground">
            Enable two-factor first to change your password.
          </p>
        ) : showForm ? (
          <form onSubmit={submit} className="space-y-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {account.passwordSet && (
              <div className="space-y-1.5">
                <Label htmlFor="current">Current password</Label>
                <Input
                  id="current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="next">New password</Label>
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save password'}
            </Button>
          </form>
        ) : (
          <Button onClick={begin}>
            {account.passwordSet ? 'Change password' : 'Set password'}
          </Button>
        )}
      </CardContent>
      <StepUpModal
        open={showStepUp}
        onOpenChange={setShowStepUp}
        onVerified={() => setShowForm(true)}
      />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
