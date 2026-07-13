import { Button } from '@fx/ui';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { SettingsView } from './settings-view';

/** FE-100 — settings (risk params, clustering, session multipliers, gating). */
export default function SettingsPage() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Risk parameters and platform behaviour."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/account">Account &amp; security</Link>
          </Button>
        }
      />
      <SettingsView />
    </div>
  );
}
