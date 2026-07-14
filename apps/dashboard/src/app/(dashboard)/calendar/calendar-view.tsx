'use client';

import type { EconomicCalendarEvent } from '@fx/types';
import { Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, cn } from '@fx/ui';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useCalendar } from '@/lib/hooks';

/**
 * FE-101 — economic calendar, wired to BE-110 (Step 5.3). High-impact events
 * render with their ±blackoutMinutes window; a currently-active blackout
 * shows the entries-paused banner. When the provider is unavailable/stale the
 * page says so honestly — the risk gate is fail-open (`calendar_unavailable`).
 */
export function CalendarView() {
  const calendar = useCalendar();

  if (calendar.isError) return <ErrorState error={calendar.error} />;
  if (calendar.isLoading || !calendar.data) return <LoadingRows rows={5} />;

  const { events, available, provider, lastFetchedAt, blackoutMinutes } = calendar.data;
  const now = Date.now();
  const windowMs = blackoutMinutes * 60_000;
  const activeBlackouts = events.filter(
    (e) => e.impact === 'high' && Math.abs(new Date(e.ts).getTime() - now) <= windowMs,
  );

  return (
    <div className="space-y-4">
      {!available && (
        <Alert>
          <AlertTitle>Calendar data unavailable or stale</AlertTitle>
          <AlertDescription>
            Provider <code>{provider}</code>
            {lastFetchedAt
              ? ` last refreshed ${new Date(lastFetchedAt).toLocaleString()}.`
              : ' has never refreshed.'}{' '}
            Entries are never blocked on a missing calendar (fail-open): the blackout rule records{' '}
            <code>calendar_unavailable</code> and passes.
          </AlertDescription>
        </Alert>
      )}

      {activeBlackouts.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Blackout active — entries paused</AlertTitle>
          <AlertDescription>
            {activeBlackouts.map((e) => `${e.currency} ${e.title}`).join(' · ')} — the risk gate
            blocks affected-currency entries within ±{blackoutMinutes} min.
          </AlertDescription>
        </Alert>
      )}

      {events.length === 0 ? (
        <EmptyState
          title="No upcoming events"
          description={
            available
              ? 'The vendor feed has no events in this window.'
              : 'Events appear here once the calendar refresh job has run (market-data worker).'
          }
        />
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {events.map((e) => (
              <EventRow key={e.id} event={e} blackoutMinutes={blackoutMinutes} now={now} />
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        High-impact rows shade their ±{blackoutMinutes} min blackout window. Source: {provider}
        {lastFetchedAt && <> · refreshed {new Date(lastFetchedAt).toLocaleString()}</>}
      </p>
    </div>
  );
}

const IMPACT_VARIANT = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
} as const;

function EventRow({
  event: e,
  blackoutMinutes,
  now,
}: {
  event: EconomicCalendarEvent;
  blackoutMinutes: number;
  now: number;
}) {
  const ts = new Date(e.ts);
  const inBlackout =
    e.impact === 'high' && Math.abs(ts.getTime() - now) <= blackoutMinutes * 60_000;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm',
        inBlackout && 'bg-warning/15',
      )}
    >
      <span className="w-40 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {ts.toLocaleString()}
      </span>
      <Badge variant={IMPACT_VARIANT[e.impact]} className="w-16 justify-center text-[10px]">
        {e.impact.toUpperCase()}
      </Badge>
      <span className="w-12 font-mono font-semibold">{e.currency}</span>
      <span className="min-w-0 flex-1">{e.title}</span>
      <span className="font-mono text-xs text-muted-foreground">
        {e.forecast && <>f {e.forecast} </>}
        {e.previous && <>p {e.previous}</>}
      </span>
      {inBlackout && (
        <Badge variant="destructive" className="text-[10px]">
          BLACKOUT
        </Badge>
      )}
    </div>
  );
}
