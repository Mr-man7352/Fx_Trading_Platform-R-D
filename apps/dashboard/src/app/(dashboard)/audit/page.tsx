import { PageHeader } from '@/components/page-header';
import { AuditView } from './audit-view';

/** FE-102 — audit log viewer. */
export default function AuditPage() {
  return (
    <div>
      <PageHeader title="Audit log" description="Append-only record of every state change." />
      <AuditView />
    </div>
  );
}
