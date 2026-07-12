import { FakeEmbeddingAdapter } from '@fx/llm';
import { describe, expect, it } from 'vitest';
import { cosineSimilarity, deterministicUuid, InMemoryAgentMemory } from './backtest-memory.js';

/** QN-056 — run-local memory: empty start, temporal filter, deterministic. */

function store(): InMemoryAgentMemory {
  return new InMemoryAgentMemory(new FakeEmbeddingAdapter());
}

const T0 = new Date('2026-07-06T00:00:00Z');
const T1 = new Date('2026-07-06T01:00:00Z');
const T2 = new Date('2026-07-06T02:00:00Z');

describe('InMemoryAgentMemory', () => {
  it('starts empty — never seeded from live memory', async () => {
    const m = store();
    expect(m.size).toBe(0);
    const got = await m.retrieve({
      instrument: 'EUR_USD',
      barTs: T2,
      agentRole: 'pm',
      queryText: 'anything',
    });
    expect(got).toEqual([]);
  });

  it('enforces the hard temporal filter (barTs <= current bar)', async () => {
    const m = store();
    await m.writeReflection({
      instrument: 'EUR_USD',
      barTs: T2,
      agentRole: 'pm',
      signalId: null,
      summary: 'future reflection',
    });
    const got = await m.retrieve({
      instrument: 'EUR_USD',
      barTs: T1,
      agentRole: 'pm',
      queryText: 'future reflection',
    });
    expect(got).toEqual([]); // written at T2, invisible at T1
  });

  it('filters by instrument and ranks deterministically', async () => {
    const m = store();
    await m.writeReflection({
      instrument: 'EUR_USD',
      barTs: T0,
      agentRole: 'pm',
      signalId: null,
      summary: 'euro trend continuation setup',
    });
    await m.writeReflection({
      instrument: 'XAU_USD',
      barTs: T0,
      agentRole: 'pm',
      signalId: null,
      summary: 'gold breakout setup',
    });
    const got = await m.retrieve({
      instrument: 'EUR_USD',
      barTs: T2,
      agentRole: 'pm',
      queryText: 'euro trend continuation setup',
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.summary).toContain('euro');
  });

  it('merges near-duplicates at write time (identical text ⇒ same row)', async () => {
    const m = store();
    const a = await m.writeReflection({
      instrument: 'EUR_USD',
      barTs: T0,
      agentRole: 'pm',
      signalId: 'sig-1',
      summary: 'identical reflection text',
    });
    const b = await m.writeReflection({
      instrument: 'EUR_USD',
      barTs: T1,
      agentRole: 'pm',
      signalId: 'sig-2',
      summary: 'identical reflection text',
    });
    expect(b.merged).toBe(true);
    expect(b.id).toBe(a.id);
    expect(m.size).toBe(1);
    // The merged row inherited the NEW signal id — outcomes attach there.
    const updated = await m.recordOutcome('sig-2', { rMultiple: 1.2, exitReason: 'TP' });
    expect(updated).toBe(1);
  });

  it('attaches outcomes by signalId and surfaces them on retrieval', async () => {
    const m = store();
    await m.writeReflection({
      instrument: 'EUR_USD',
      barTs: T0,
      agentRole: 'pm',
      signalId: 'sig-9',
      summary: 'stopped out into london open',
    });
    await m.recordOutcome('sig-9', { rMultiple: -1, exitReason: 'SL' });
    const got = await m.retrieve({
      instrument: 'EUR_USD',
      barTs: T2,
      agentRole: 'pm',
      queryText: 'stopped out into london open',
    });
    expect(got[0]?.outcome).toEqual({ rMultiple: -1, exitReason: 'SL' });
  });
});

describe('helpers', () => {
  it('cosineSimilarity basics', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it('deterministicUuid is stable and uuid-shaped', () => {
    const a = deterministicUuid('seed-x');
    expect(a).toBe(deterministicUuid('seed-x'));
    expect(a).not.toBe(deterministicUuid('seed-y'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
