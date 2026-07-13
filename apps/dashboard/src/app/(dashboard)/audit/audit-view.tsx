'use client';

import type { AuditLogEntry } from '@fx/types';
import { Badge, Button, Card, CardContent, Input, Label } from '@fx/ui';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useAudit } from '@/lib/hooks';

/**
 * FE-102 — append-only audit log viewer (BE-130). Filter by method / actor /
 * date; immutable rows show actor, timestamp, request id, status, mode. This
 * surface is fully wired to `GET /audit`.
 */
export function AuditView() {
  const [page, setPage] = useState(1);
  const [method, setMethod] = useState('');
  const [actorId, setActorId] = useState('');
  const pageSize = 50;

  const query = useAudit({
    page,
    pageSize,
    ...(method ? { method } : {}),
    ...(actorId ? { actorId } : {}),
  });

  const data = query.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Method</Label>
            <select
              value={method}
              onChange={(e) => {
                setMethod(e.target.value);
                setPage(1);
              }}
              className="rounded-md border bg-card px-2 py-1.5 text-sm"
            >
              <option value="">all</option>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Actor id</Label>
            <Input
              value={actorId}
              onChange={(e) => {
                setActorId(e.target.value);
                setPage(1);
              }}
              placeholder="user id"
              className="w-48"
            />
          </div>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {total.toLocaleString()} entries
          </span>
        </CardContent>
      </Card>

      {query.isError ? (
        <ErrorState error={query.error} />
      ) : query.isLoading ? (
        <LoadingRows rows={8} />
      ) : items.length === 0 ? (
        <EmptyState title="No audit entries" description="No entries match these filters." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3 font-medium">Time</th>
                  <th className="p-3 font-medium">Actor</th>
                  <th className="p-3 font-medium">Request</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium">Mode</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <AuditRow key={e.id} entry={e} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function AuditRow({ entry: e }: { entry: AuditLogEntry }) {
  const bad = e.statusCode >= 400;
  return (
    <tr className="border-b">
      <td className="p-3 tabular-nums">{new Date(e.at).toLocaleString()}</td>
      <td className="p-3 font-mono text-xs">
        {e.actorId ?? 'system'}
        <span className="ml-1 text-muted-foreground">({e.role})</span>
      </td>
      <td className="p-3 font-mono text-xs">
        <span className="text-muted-foreground">{e.method}</span> {e.url}
        <span className="ml-1 block text-[10px] text-muted-foreground">req {e.requestId}</span>
      </td>
      <td className="p-3">
        <Badge variant={bad ? 'destructive' : 'secondary'} className="font-mono">
          {e.statusCode}
        </Badge>
      </td>
      <td className="p-3 font-mono text-xs">{e.tradingMode}</td>
    </tr>
  );
}
