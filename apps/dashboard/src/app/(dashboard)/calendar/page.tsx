import { PageHeader } from '@/components/page-header';
import { CalendarView } from './calendar-view';

/**
 * FE-101 — economic calendar. Events + ±30 min blackout shading come from
 * `GET /calendar` (BE-110, Step 5.3 — vendor-refreshed by the market-data
 * worker); the unavailable/stale state renders honestly (fail-open).
 */
export default function CalendarPage() {
  return (
    <div>
      <PageHeader
        title="Economic calendar"
        description="Upcoming high-impact events and active entry-blackout windows."
      />
      <CalendarView />
    </div>
  );
}
