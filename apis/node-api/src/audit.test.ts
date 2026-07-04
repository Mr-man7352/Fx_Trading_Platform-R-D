import { describe, expect, it, vi } from 'vitest';
import { type AuditEvent, DbAuditSink } from './audit.js';

// BE-130 — DbAuditSink unit tests against the structural AuditLogWriter slice.
const event: AuditEvent = {
  at: '2026-07-04T00:00:00.000Z',
  requestId: 'req-1',
  actorId: 'internal',
  role: 'internal',
  method: 'POST',
  url: '/v1/test',
  statusCode: 201,
  tradingMode: 'paper',
};

function fakeLog() {
  return { info: vi.fn(), error: vi.fn() } as never;
}

describe('DbAuditSink', () => {
  it('writes the event as an audit_log row (at → Date)', async () => {
    const create = vi.fn().mockResolvedValue({});
    const sink = new DbAuditSink({ auditLog: { create } }, fakeLog());
    await sink.append(event);
    expect(create).toHaveBeenCalledWith({
      data: { ...event, at: new Date(event.at) },
    });
  });

  it('never throws when the DB write fails — logs at error level instead', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const log = { info: vi.fn(), error: vi.fn() };
    const sink = new DbAuditSink({ auditLog: { create } }, log as never);
    await expect(sink.append(event)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ audit: true, requestId: 'req-1' });
  });
});
