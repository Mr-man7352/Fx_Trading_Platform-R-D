import { PageHeader } from '@/components/page-header';
import { TradesView } from './trades-view';

/** FE-070 — trades history with provenance. */
export default function TradesPage() {
  return (
    <div>
      <PageHeader title="Trades" description="Every fill, expandable to its full provenance." />
      <TradesView />
    </div>
  );
}
