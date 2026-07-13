import { PageHeader } from '@/components/page-header';
import { ChartsView } from './charts-view';

/** FE-050 — market charts. */
export default function ChartsPage() {
  return (
    <div>
      <PageHeader title="Charts" description="Candles, EMAs, and system signal markers." />
      <ChartsView />
    </div>
  );
}
