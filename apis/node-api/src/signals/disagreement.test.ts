/** BE-065 — disagreement cohort classification + persistence. */

import { describe, expect, it } from 'vitest';
import type { AgentGraphResult } from './agent-graph.js';
import { classifyDisagreement, type DisagreementWriter, logDisagreement } from './disagreement.js';

function result(decision: AgentGraphResult['decision'], rationale = 'because'): AgentGraphResult {
  return {
    decision,
    holdReason: decision === 'HOLD' ? 'STAGE_TIMEOUT' : null,
    holdDetail: decision === 'HOLD' ? 'trader timed out' : null,
    specialists: {
      technical: { stance: 'BULL', confidence: 0.7, rationale: 'x' },
      macro: { stance: 'NEUTRAL', confidence: 0.5, rationale: 'x' },
      sentiment: { stance: 'BULL', confidence: 0.6, rationale: 'x' },
    },
    transcript: [],
    notes: [],
    degradedRoles: [],
    tiebreakerApplied: false,
    tiebreakerOverrode: false,
    trader: null,
    risk: null,
    digest: null,
    pm: decision === 'HOLD' ? null : { decision, rationale },
    costUsd: 0,
    llmCalls: 0,
  };
}

describe('classifyDisagreement', () => {
  it('quant yes (P ≥ threshold) + PM veto → QUANT_YES_PM_VETO', () => {
    expect(classifyDisagreement(0.63, 0.6, 'VETO')).toBe('QUANT_YES_PM_VETO');
  });
  it('quant yes + PM hold → QUANT_YES_PM_HOLD', () => {
    expect(classifyDisagreement(0.6, 0.6, 'HOLD')).toBe('QUANT_YES_PM_HOLD');
  });
  it('quant no (P < threshold) + PM approve → QUANT_NO_PM_APPROVE', () => {
    expect(classifyDisagreement(0.55, 0.6, 'APPROVE')).toBe('QUANT_NO_PM_APPROVE');
  });
  it('agreement → null (both yes, or both no)', () => {
    expect(classifyDisagreement(0.63, 0.6, 'APPROVE')).toBeNull();
    expect(classifyDisagreement(0.55, 0.6, 'VETO')).toBeNull();
    expect(classifyDisagreement(0.55, 0.6, 'HOLD')).toBeNull();
  });
});

describe('logDisagreement', () => {
  function fakeDb() {
    const created: unknown[] = [];
    const db: DisagreementWriter = {
      disagreementEvent: {
        create: async (args) => {
          created.push(args.data);
          return args.data;
        },
      },
    };
    return { db, created };
  }

  it('persists a row with the PM rationale on veto', async () => {
    const { db, created } = fakeDb();
    const kind = await logDisagreement(db, {
      signalId: 'sig-1',
      quantProbability: 0.63,
      probabilityThreshold: 0.6,
      result: result('VETO', 'macro contradicts'),
    });
    expect(kind).toBe('QUANT_YES_PM_VETO');
    expect(created[0]).toMatchObject({
      signalId: 'sig-1',
      kind: 'QUANT_YES_PM_VETO',
      quantProbability: 0.63,
      pmDecision: 'VETO',
      pmRationale: 'macro contradicts',
    });
  });

  it('falls back to holdDetail for deterministic HOLDs (no PM output)', async () => {
    const { db, created } = fakeDb();
    const kind = await logDisagreement(db, {
      signalId: 'sig-2',
      quantProbability: 0.61,
      probabilityThreshold: 0.6,
      result: result('HOLD'),
    });
    expect(kind).toBe('QUANT_YES_PM_HOLD');
    expect(created[0]).toMatchObject({ pmRationale: 'trader timed out' });
  });

  it('writes nothing on agreement', async () => {
    const { db, created } = fakeDb();
    const kind = await logDisagreement(db, {
      signalId: 'sig-3',
      quantProbability: 0.63,
      probabilityThreshold: 0.6,
      result: result('APPROVE'),
    });
    expect(kind).toBeNull();
    expect(created).toHaveLength(0);
  });
});
