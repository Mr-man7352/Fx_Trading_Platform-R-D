import { PageHeader } from '@/components/page-header';
import { QuantView } from './quant-view';

/** FE-090 — quant analytics. */
export default function QuantPage() {
  return (
    <div>
      <PageHeader
        title="Quant"
        description="Meta-model calibration, regime timeline, and champion status."
      />
      <QuantView />
    </div>
  );
}
