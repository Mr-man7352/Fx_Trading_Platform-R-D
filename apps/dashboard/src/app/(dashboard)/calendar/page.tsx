import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@fx/ui';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';

/**
 * FE-101 — economic calendar. High-impact events with ±30 min blackout shading
 * and an active-blackout banner. No vendor is wired yet — the blackout rule and
 * `pre_news_flatten` currently record `calendar_unavailable` and pass; BE-110 is
 * where a real `CalendarProvider` lands and this page surfaces it.
 */
export default function CalendarPage() {
  return (
    <div>
      <PageHeader
        title="Economic calendar"
        description="Upcoming high-impact events and active entry-blackout windows."
      />
      <div className="space-y-4">
        <Alert>
          <AlertTitle>No calendar provider wired</AlertTitle>
          <AlertDescription>
            Entries are never blocked on a missing calendar (fail-open): the blackout rule records{' '}
            <code>calendar_unavailable</code> and passes. Events and ±30 min shading appear here
            once BE-110 lands.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">How blackouts will show</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Each high-impact release renders a row with a shaded ±30 min window; while a window is
              active, the dashboard shows a banner pausing entries for the affected pairs.
            </p>
            <div className="flex items-center gap-2">
              <span className="inline-block h-4 w-16 rounded bg-warning/25" />
              <span className="text-xs">= blackout window (entries paused)</span>
            </div>
          </CardContent>
        </Card>

        <EmptyState
          title="No upcoming events"
          description="Connect a calendar provider (BE-110) to populate NFP, CPI, FOMC, and other high-impact releases."
        />
      </div>
    </div>
  );
}
