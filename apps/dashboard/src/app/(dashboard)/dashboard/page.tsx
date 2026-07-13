import { PageHeader } from '@/components/page-header';
import { HealthStrip } from './health-strip';
import { Home } from './home';

/**
 * FE-040/FE-042 — operator home. The AppShell chrome (nav, mode badge,
 * kill-switch, disclaimer) is provided by the (dashboard) layout; this page owns
 * the health strip and the at-a-glance tiles.
 */
export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Operator home" description="Platform state at a glance." />
      <HealthStrip />
      <Home />
    </div>
  );
}
