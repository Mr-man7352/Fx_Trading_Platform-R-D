import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTRACT_VERSION,
  AgentContextContract,
  type AgentRole,
  DebateDigestSchema,
  PmOutputSchema,
  type QuantCandidate,
  RiskTeamOutputSchema,
  SpecialistOutputSchema,
  TraderOutputSchema,
  validateAgentOutput,
} from './agents.js';

/** BE-069 — golden fixtures per role; CI gate for schema drift. */

const candidate: QuantCandidate = {
  instrument: 'EUR_USD',
  side: 'long',
  probability: 0.63,
  regime: 'TREND_UP/NORMAL',
  modelVersion: 'EUR_USD-H1-v3',
  entryPrice: 1.0842,
  stopLossPrice: 1.0791,
  takeProfitPrice: 1.0944,
};

const pipeline = {
  instrument: 'EUR_USD',
  timeframe: 'H1',
  barTs: '2026-07-09T14:00:00Z',
  sessionLabel: 'OVERLAP',
  liquidityRegime: 'HIGH',
  trendRegime: 'TREND_UP',
  regimeEntropy: 0.35,
  debateRounds: 1,
  featureSetVersion: 3,
} as const;

const base = {
  contractVersion: AGENT_CONTRACT_VERSION,
  pipeline,
  candidate,
  memories: [],
} as const;

const specialistOut = { stance: 'BULL', confidence: 0.7, rationale: 'Momentum + S/R align.' };
const researcherOut = { argument: 'Trend continuation likely.', confidence: 0.65 };
const traderOut = { action: 'ENTER', direction: 'long', confidence: 0.66 };
const riskOut = { approve: true, concerns: ['news blackout in 6h'] };
const pmOut = { decision: 'APPROVE', rationale: 'Consensus with quant; risk accepted.' };

const specialists = {
  technical: specialistOut,
  macro: { stance: 'NEUTRAL', confidence: 0.5, rationale: 'No fresh releases.' },
  sentiment: { stance: 'BULL', confidence: 0.55, rationale: 'Net-positive headlines.' },
} as const;

const turn = { round: 0, speaker: 'bull', argument: 'Breakout confirmed.', confidence: 0.6 } as const;

const goldenInputs: Record<AgentRole, Record<string, unknown>> = {
  technical_analyst: {
    ...base,
    role: 'technical_analyst',
    indicators: { rsi_14: 61.2, atr_14: 0.0021, ema_50_dist: 0.0034 },
    supportResistance: [{ level: 1.0791, kind: 'SUPPORT' }],
  },
  macro_analyst: {
    ...base,
    role: 'macro_analyst',
    macroFeatures: { cot_net_noncomm: 42_113, fred_dxy_yoy: -0.021 },
    featuresAsOf: '2026-07-08T20:00:00Z',
  },
  sentiment_analyst: {
    ...base,
    role: 'sentiment_analyst',
    sentimentFeatures: { finbert_mean_24h: 0.31, headline_count_24h: 12 },
    news: {
      kind: 'UNTRUSTED_DATA',
      headlines: [
        {
          publishedAt: '2026-07-09T11:30:00Z',
          source: 'reuters',
          headline: 'ECB officials signal steady policy path',
          sentimentScore: 0.4,
        },
      ],
    },
  },
  bull_researcher: {
    ...base,
    role: 'bull_researcher',
    specialists,
    priorTurns: [],
    round: 0,
  },
  bear_researcher: {
    ...base,
    role: 'bear_researcher',
    specialists,
    priorTurns: [turn],
    round: 1,
  },
  trader: {
    ...base,
    role: 'trader',
    specialists,
    debateTranscript: [turn, { ...turn, speaker: 'bear', argument: 'Overextended.' }],
    tiebreakerMode: 'NONE',
  },
  risk_team: {
    ...base,
    role: 'risk_team',
    trader: traderOut,
    quantProbability: 0.63,
    account: { equity: 100_000, openPositions: 1, dailyPnlPct: -0.004, openRiskPct: 0.01 },
  },
  pm: {
    ...base,
    role: 'pm',
    risk: riskOut,
    trader: traderOut,
    digest: {
      stances: {
        technical: { stance: 'BULL', confidence: 0.7 },
        macro: { stance: 'NEUTRAL', confidence: 0.5 },
        sentiment: { stance: 'BULL', confidence: 0.55 },
      },
      finalRound: { bull: researcherOut, bear: { ...researcherOut, confidence: 0.4 } },
      traderAction: traderOut,
      riskConcerns: riskOut.concerns,
      tiebreakerApplied: false,
      degradedRoles: [],
    },
  },
};

const goldenOutputs: Record<AgentRole, unknown> = {
  technical_analyst: specialistOut,
  macro_analyst: specialistOut,
  sentiment_analyst: specialistOut,
  bull_researcher: researcherOut,
  bear_researcher: researcherOut,
  trader: traderOut,
  risk_team: riskOut,
  pm: pmOut,
};

describe('AgentContextContract (BE-069)', () => {
  it('defines schemas for all 8 roles', () => {
    expect(Object.keys(AgentContextContract)).toHaveLength(8);
  });

  for (const role of Object.keys(AgentContextContract) as AgentRole[]) {
    it(`${role}: golden input bundle validates`, () => {
      expect(() => AgentContextContract[role].input.parse(goldenInputs[role])).not.toThrow();
    });

    it(`${role}: golden output validates via validateAgentOutput`, () => {
      const res = validateAgentOutput(role, goldenOutputs[role]);
      expect(res.ok).toBe(true);
    });
  }

  it('rejects a bundle with the wrong contract version', () => {
    const bad = { ...goldenInputs.trader, contractVersion: AGENT_CONTRACT_VERSION + 1 };
    expect(AgentContextContract.trader.input.safeParse(bad).success).toBe(false);
  });

  it('rejects extra keys on outputs (strict — LLM JSON must match exactly)', () => {
    expect(
      SpecialistOutputSchema.safeParse({ ...specialistOut, extra: 'nope' }).success,
    ).toBe(false);
    expect(PmOutputSchema.safeParse({ ...pmOut, note: 'x' }).success).toBe(false);
  });

  it('rejects ENTER without a direction', () => {
    expect(
      TraderOutputSchema.safeParse({ action: 'ENTER', direction: null, confidence: 0.6 }).success,
    ).toBe(false);
    expect(
      TraderOutputSchema.safeParse({ action: 'HOLD', direction: null, confidence: 0.6 }).success,
    ).toBe(true);
  });

  it('rejects out-of-range confidence and empty rationale', () => {
    expect(
      SpecialistOutputSchema.safeParse({ ...specialistOut, confidence: 1.2 }).success,
    ).toBe(false);
    expect(
      SpecialistOutputSchema.safeParse({ ...specialistOut, rationale: '' }).success,
    ).toBe(false);
  });

  it('validateAgentOutput returns ok:false (not throw) on garbage', () => {
    const res = validateAgentOutput('pm', { decision: 'MAYBE' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('decision');
  });

  it('risk_team output requires approve boolean + concerns list', () => {
    expect(RiskTeamOutputSchema.safeParse({ approve: 'yes', concerns: [] }).success).toBe(false);
  });

  it('digest is the ADR-011 deterministic shape (nullable final round)', () => {
    const digest = (goldenInputs.pm as { digest: unknown }).digest;
    expect(DebateDigestSchema.safeParse(digest).success).toBe(true);
    const noDebate = { ...(digest as Record<string, unknown>), finalRound: { bull: null, bear: null } };
    expect(DebateDigestSchema.safeParse(noDebate).success).toBe(true);
  });
});
