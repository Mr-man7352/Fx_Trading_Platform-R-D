import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AccountSettings } from '@/components/account-settings';

/** FE-036 — account settings surface (guarded; middleware also gates /settings). */
export default async function AccountSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in?callbackUrl=/settings/account');

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-xl font-semibold">Account settings</h1>
      <AccountSettings />
    </main>
  );
}
