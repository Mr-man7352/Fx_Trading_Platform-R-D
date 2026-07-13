import { PageHeader } from '@/components/page-header';
import { BacktestView } from './backtest-view';

/** FE-080 — backtest config + results (consumes BE-090). */
export default function BacktestPage() {
  return (
    <div>
      <PageHeader
        title="Backtest"
        description="Configure runs and inspect OOS metrics, validation verdict, and ablations."
      />
      <BacktestView />
    </div>
  );
}
