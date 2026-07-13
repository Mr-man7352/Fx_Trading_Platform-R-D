'use client';

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@fx/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthApiError, register } from '@/lib/auth-api';

/** FE-031 — email/password registration gated by an invite code (BE-032/035). */
export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '', inviteCode: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        email: form.email,
        password: form.password,
        inviteCode: form.inviteCode.trim(),
        name: form.name || undefined,
      });
      router.push(`/verify-pending?email=${encodeURIComponent(form.email)}`);
    } catch (err) {
      setError(mapError(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          An invite code is required — this platform is invite-only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={onSubmit} className="space-y-3">
          <Field
            id="inviteCode"
            label="Invite code"
            value={form.inviteCode}
            onChange={set('inviteCode')}
            placeholder="FX-XXXX-XXXX"
            required
          />
          <Field
            id="name"
            label="Name (optional)"
            value={form.name}
            onChange={set('name')}
            autoComplete="name"
          />
          <Field
            id="email"
            label="Email"
            type="email"
            value={form.email}
            onChange={set('email')}
            autoComplete="email"
            required
          />
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={set('password')}
            />
            <p className="text-xs text-muted-foreground">
              At least 12 characters, with a letter and a number.
            </p>
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/sign-in" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const { id, label, ...rest } = props;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...rest} />
    </div>
  );
}

function mapError(err: unknown): string {
  if (err instanceof AuthApiError) {
    if (err.code === 'INVITE_INVALID') return 'That invite code is invalid or expired.';
    if (err.code === 'EMAIL_TAKEN') return 'An account with this email already exists.';
    if (err.code === 'VALIDATION') return 'Please check the form and try again.';
  }
  return 'Registration failed. Please try again.';
}
