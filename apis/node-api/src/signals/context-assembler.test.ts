/** BE-074 — context assembler: partitioning, PIT headlines, validation, digest. */

import type { RetrievedMemory, SpecialistOutputs, TraderOutput } from '@fx/types';
import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  ContextAssembler,
  effectiveDebateRounds,
  extractSupportResistance,
  type MemoryRetriever,
  type NewsReader,
  partitionFeatures,
  tiebreakerMode,
} from './context-assembler.js';
import type { PipelineResult } from './quant-pipeline-client.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BAR_TS = new Date('2026-07-09T13:00:00.000Z');

const features: Record<string, number> = {
  rsi_14: 61.2,
  atr_14: 0.0042,
  ema_50_dist: 0.0011,
  sr_support_1: 1.081,
  sr_resistance_1: 1.094,
  macro_dxy: 104.2,
  macro_dxy_age_days: 0.5,
  sent_mean_24h: 0.31,
  sent_n_24h: 4,
};

const pipelineResult: PipelineResult = {
  features,
  hasCandidate: true,
  candidate: {
    instrument: 'EUR_USD',
    side: 'long',
    probability: 0.63,
    regime: 'TREND_UP',
    modelVersion: 'EUR_USD/H1 v3',
    entryPrice: 1.0885,
    stopLossPrice: 1.0845,
    takeProfitPrice: 1.0965,
  },
  sessionLabel: 'LONDON',
  liquidityRegime: 'HIGH',
  trendRegime: 'TREND_UP',
  regimeEntropy: 0.41,
  debateRounds: 1,
  featureSetVersion: 1,
  challengerProbability: null,
};

const emptyNews: NewsReader = { queryNews: async () => [] };

function assembler(news: NewsReader = emptyNews, memory?: MemoryRetriever) {
  return new ContextAssembler({ news, memory });
}

function prepared(result: PipelineResult = pipelineResult) {
  const outcome = assembler().prepare({
    result,
    instrument: 'EUR_USD',
    timeframe: 'H1',
    barTs: BAR_TS,
    configuredDebateRounds: 1,
  });
  if (!outcome.ok) throw new Error(`prepare failed: ${outcome.detail}`);
  return outcome.prepared;
}

const specialists: SpecialistOutputs = {
  technical: { stance: 'BULL', confidence: 0.7, rationale: 'trend intact' },
  macro: { stance: 'NEUTRAL', confidence: 0.5, rationale: 'mixed dollar' },
  sentiment: { stance: 'BULL', confidence: 0.6, rationale: 'positive flow' },
};

const traderEnter: TraderOutput = { action: 'ENTER', direction: 'long', confidence: 0.66 };

// ─── Partitioning (mirrors quant partition_features) ─────────────────────────

describe('partitionFeatures', () => {
  it('routes macro_*/sent_* and leaves the rest technical — total preserved', () => {
    const p = partitionFeatures(features);
    expect(Object.keys(p.macro).sort()).toEqual(['macro_dxy', 'macro_dxy_age_days']);
    expect(Object.keys(p.sentiment).sort()).toEqual(['sent_mean_24h', 'sent_n_24h']);
    expect(Object.keys(p.technical)).toContain('rsi_14');
    expect(
      Object.keys(p.technical).length +
        Object.keys(p.macro).length +
        Object.keys(p.sentiment).length,
    ).toBe(Object.keys(features).length);
  });
});

describe('effectiveDebateRounds', () => {
  it('respects static config below the entropy threshold', () => {
    expect(effectiveDebateRounds(0, 0.2)).toBe(0);
    expect(effectiveDebateRounds(2, 0.2)).toBe(2);
  });
  it('forces 2 rounds at high entropy regardless of config (BE-062 AC)', () => {
    expect(effectiveDebateRounds(0, 0.7)).toBe(2);
    expect(effectiveDebateRounds(1, 2 / 3)).toBe(2);
  });
});

describe('tiebreakerMode', () => {
  it('QUANT_DEFAULT on split vote (<0.1), NONE otherwise or when a side is missing', () => {
    expect(tiebreakerMode(0.55, 0.5)).toBe('QUANT_DEFAULT');
    expect(tiebreakerMode(0.8, 0.5)).toBe('NONE');
    expect(tiebreakerMode(null, 0.5)).toBe('NONE');
  });
});

describe('extractSupportResistance', () => {
  it('pulls sr_* keys sorted by level', () => {
    expect(extractSupportResistance(partitionFeatures(features).technical)).toEqual([
      { level: 1.081, kind: 'SUPPORT' },
      { level: 1.094, kind: 'RESISTANCE' },
    ]);
  });
});

// ─── prepare ─────────────────────────────────────────────────────────────────

describe('prepare', () => {
  it('GATE_SKIP when no candidate', () => {
    const out = assembler().prepare({
      result: { ...pipelineResult, hasCandidate: false, candidate: null },
      instrument: 'EUR_USD',
      timeframe: 'H1',
      barTs: BAR_TS,
      configuredDebateRounds: 1,
    });
    expect(out).toMatchObject({ ok: false, reason: 'GATE_SKIP' });
  });

  it('SCHEMA_INVALID on unknown enum from gRPC — fails before any LLM cost', () => {
    const out = assembler().prepare({
      result: { ...pipelineResult, sessionLabel: 'MARS' },
      instrument: 'EUR_USD',
      timeframe: 'H1',
      barTs: BAR_TS,
      configuredDebateRounds: 1,
    });
    expect(out).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });
});

// ─── Role bundles ────────────────────────────────────────────────────────────

describe('specialist bundles', () => {
  it('technical bundle validates and carries ONLY the technical partition', async () => {
    const out = await assembler().assembleTechnical(prepared());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.indicators).not.toHaveProperty('macro_dxy');
    expect(out.input.indicators).not.toHaveProperty('sent_mean_24h');
    expect(out.input.supportResistance).toHaveLength(2);
  });

  it('macro bundle carries only macro_* features', async () => {
    const out = await assembler().assembleMacro(prepared());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.input.macroFeatures).every((k) => k.startsWith('macro_'))).toBe(true);
  });

  it('sentiment bundle wraps PIT headlines in the untrusted block', async () => {
    const news: NewsReader = {
      queryNews: async (params) => {
        expect(params.asOf).toEqual(BAR_TS);
        expect(params.instrument).toBe('EUR_USD');
        return [
          {
            publishedAt: '2026-07-09T11:30:00.000Z',
            source: 'reuters',
            headline: 'ECB holds rates',
            sentiment: 0.2,
          },
        ];
      },
    };
    const out = await assembler(news).assembleSentiment(prepared());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.news.kind).toBe('UNTRUSTED_DATA');
    expect(out.input.news.headlines[0]?.headline).toBe('ECB holds rates');
  });

  it('news read failure → SCHEMA_INVALID outcome, never a throw', async () => {
    const news: NewsReader = {
      queryNews: async () => {
        throw new Error('db down');
      },
    };
    const out = await assembler(news).assembleSentiment(prepared());
    expect(out).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });

  it('memory retrieval failure degrades to [] — bundle still valid', async () => {
    const memory: MemoryRetriever = {
      retrieve: async () => {
        throw new Error('pgvector down');
      },
    };
    const out = await assembler(emptyNews, memory).assembleTechnical(prepared());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.input.memories).toEqual([]);
  });

  it('memories flow into the bundle when the retriever returns them', async () => {
    const mem: RetrievedMemory = {
      id: '7d9f9c2e-4b1a-4f7e-9a3c-2f6b8d1e5a90',
      barTs: '2026-07-01T13:00:00.000Z',
      summary: 'prior EUR_USD long in LONDON trend worked (+1.8R)',
      outcome: { rMultiple: 1.8 },
    };
    const memory: MemoryRetriever = { retrieve: async () => [mem] };
    const out = await assembler(emptyNews, memory).assembleMacro(prepared());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.input.memories).toEqual([mem]);
  });
});

describe('downstream bundles', () => {
  it('trader receives full transcript + tiebreaker mode', async () => {
    const out = await assembler().assembleTrader(
      prepared(),
      specialists,
      [{ round: 0, speaker: 'bull', argument: 'momentum', confidence: 0.6 }],
      'QUANT_DEFAULT',
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.input.tiebreakerMode).toBe('QUANT_DEFAULT');
  });

  it('risk team gets raw quant probability, pre-any-agent', async () => {
    const out = await assembler().assembleRiskTeam(prepared(), traderEnter, {
      equity: 10_000,
      openPositions: 1,
      dailyPnlPct: -0.004,
      openRiskPct: 0.01,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.input.quantProbability).toBe(0.63);
  });

  it('PM bundle takes the digest, not a transcript', async () => {
    const digest = buildDigest({
      specialists,
      finalBull: { argument: 'buy dips', confidence: 0.65 },
      finalBear: { argument: 'stretched', confidence: 0.5 },
      trader: traderEnter,
      risk: { approve: true, concerns: ['event risk Friday'] },
      tiebreakerApplied: false,
      degradedRoles: [],
    });
    const out = await assembler().assemblePm(
      prepared(),
      { approve: true, concerns: ['event risk Friday'] },
      traderEnter,
      digest,
    );
    expect(out.ok).toBe(true);
  });
});

// ─── Digest (ADR-011 — deterministic) ────────────────────────────────────────

describe('buildDigest', () => {
  it('is a pure deterministic function of validated outputs', () => {
    const params = {
      specialists,
      finalBull: { argument: 'a', confidence: 0.6 },
      finalBear: { argument: 'b', confidence: 0.55 },
      trader: traderEnter,
      risk: { approve: false, concerns: ['drawdown near cap'] },
      tiebreakerApplied: true,
      degradedRoles: ['sentiment_analyst' as const, 'macro_analyst' as const],
    };
    const a = buildDigest(params);
    const b = buildDigest(params);
    expect(a).toEqual(b);
    expect(a.riskConcerns).toEqual(['drawdown near cap']);
    // degraded roles sorted for byte-stable replay
    expect(a.degradedRoles).toEqual(['macro_analyst', 'sentiment_analyst']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
