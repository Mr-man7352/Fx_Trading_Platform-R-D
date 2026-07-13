import { Suspense } from 'react';
import { PageHeader } from '@/components/page-header';
import { LoadingRows } from '@/components/states';
import { AgentsView } from './agents-view';

/** FE-060 — live agent debate viewer. */
export default function AgentsPage() {
  return (
    <div>
      <PageHeader
        title="Agents"
        description="Quant candidates and the agent cycle that confirmed, vetoed, or skipped them."
      />
      <Suspense fallback={<LoadingRows rows={6} />}>
        <AgentsView />
      </Suspense>
    </div>
  );
}
