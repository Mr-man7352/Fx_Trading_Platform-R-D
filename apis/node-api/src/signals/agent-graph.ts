import type { InvokeParams, InvokeResult, PromptRegistry } from '@fx/llm';
import { LlmExhaustedError } from '@fx/llm';
import type {
  AccountState,
  AgentOutput,
  AgentRole,
  DebateDigest,
  DebateTurn,
  HoldReason,
  PmOutput,
  RiskTeamOutput,
  SpecialistOutput,
  SpecialistOutputs,
  TraderOutput,
} from '@fx/types';
import { validateAgentOutput } from '@fx/types';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  buildDigest,
  type ContextAssembler,
  type PreparedContext,
  tiebreakerMode,
} from './context-assembler.js';

/**
 * BE-062 — the agent graph (LangGraph.js): 3 domain specialists in PARALLEL
 * → bull/bear debate (0/1/2 rounds, regime-linked upstream in BE-074) →
 * trader → risk team → PM.
 *
 * Contracts enforced here:
 * - Nodes receive ONLY assembler-validated bundles (BE-074) and every LLM
 *   output is schema-validated (`validateAgentOutput`) — failure degrades
 *   the role, never throws.
 * - §2.2 budgets: each specialist 20s (parallel), each debate TURN 15s
 *   (30s/round for bull+bear), trader/risk/PM 15s each. A stage race
 *   allows the contractual +10s single-fallback overhang before declaring
 *   STAGE_TIMEOUT. The 120s full-graph budget is enforced by run().
 * - One missing specialist ⇒ NEUTRAL stance + transcript note (no
 *   whole-graph HOLD). A failed debate TURN is skipped + noted. A failed
 *   trader/risk/PM stage ⇒ deterministic HOLD with reason.
 * - §9.6 tiebreaker: bull/bear final confidences within 0.1 ⇒ trader runs
 *   under QUANT_DEFAULT and the rule is ALSO code-enforced on its output —
 *   follow the candidate iff P ≥ threshold (ADR-008 default 0.60), else
 *   HOLD; never unstructured LLM discretion.
 * - PM sees the deterministic digest only (ADR-011), built by code from
 *   validated outputs.
 * - Partial transcript survives graph-budget overruns: nodes append to a
 *   per-run collector that run() still holds after a timeout (BE-066 AC
 *   "partial transcript persisted").
 */

// ─── Budgets (§2.2) ──────────────────────────────────────────────────────────

export interface GraphBudgets {
  /** Per specialist analyst (they run in parallel). */
  specialistMs: number;
  /** Per debate TURN (bull or bear) — 2 turns = the 30s round budget. */
  debateTurnMs: number;
  /** Trader / risk team / PM, each. */
  stageMs: number;
  /** Full-graph budget enforced by run(). */
  graphMs: number;
  /** Contractual overhang: one 10s fallback attempt (§9.4) + jitter. */
  failoverGraceMs: number;
}

export const H1_BUDGETS: GraphBudgets = {
  specialistMs: 20_000,
  debateTurnMs: 15_000,
  stageMs: 15_000,
  graphMs: 120_000,
  failoverGraceMs: 12_000,
};

// ─── Results ─────────────────────────────────────────────────────────────────

export interface AgentGraphResult {
  /** PM decision, or HOLD when any hard stage failed / budget blew. */
  decision: 'APPROVE' | 'VETO' | 'HOLD';
  /** Set iff the decision is a deterministic HOLD (not a PM 'HOLD'). */
  holdReason: HoldReason | null;
  holdDetail: string | null;
  specialists: SpecialistOutputs;
  transcript: DebateTurn[];
  /** Degradation / skip notes for the persisted transcript ('judge' rows). */
  notes: string[];
  degradedRoles: AgentRole[];
  tiebreakerApplied: boolean;
  /** True when QUANT_DEFAULT overrode a non-conforming trader output. */
  tiebreakerOverrode: boolean;
  trader: TraderOutput | null;
  risk: RiskTeamOutput | null;
  digest: DebateDigest | null;
  pm: PmOutput | null;
  /** Sum of provider costs actually spent this run. */
  costUsd: number;
  llmCalls: number;
}

// ─── Deps ────────────────────────────────────────────────────────────────────

/** The one @fx/llm surface the graph needs — tests inject fakes. */
export interface LlmInvoker {
  invoke(params: InvokeParams): Promise<InvokeResult>;
}

export interface AgentGraphDeps {
  assembler: ContextAssembler;
  llm: LlmInvoker;
  registry: PromptRegistry;
  budgets?: GraphBudgets;
  /** ADR-008 — P(profitable) threshold the QUANT_DEFAULT tiebreaker uses. */
  probabilityThreshold?: number;
}

export interface AgentGraphRunParams {
  prepared: PreparedContext;
  account: AccountState;
  signalId: string | null;
}

// ─── Internals ───────────────────────────────────────────────────────────────

const NEUTRAL = (detail: string): SpecialistOutput => ({
  stance: 'NEUTRAL',
  confidence: 0,
  rationale: `degraded: ${detail}`,
});

/** Tolerant JSON extraction: strict parse first, then fenced/embedded object. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('no JSON object found in model output');
  }
}

type StageFailure = { reason: HoldReason; detail: string };
type StageOutcome<R extends AgentRole> =
  | { ok: true; value: AgentOutput<R> }
  | { ok: false; failure: StageFailure };

/** Mutable per-run collector — survives a graph-budget timeout (partial transcript). */
class RunCollector {
  transcript: DebateTurn[] = [];
  notes: string[] = [];
  degraded: AgentRole[] = [];
  costUsd = 0;
  llmCalls = 0;
}

const timeoutSentinel = Symbol('stage-timeout');

// ─── The graph ───────────────────────────────────────────────────────────────

export class AgentGraph {
  private readonly budgets: GraphBudgets;
  private readonly pThreshold: number;

  constructor(private readonly deps: AgentGraphDeps) {
    this.budgets = deps.budgets ?? H1_BUDGETS;
    this.pThreshold = deps.probabilityThreshold ?? 0.6;
  }

  /**
   * One LLM stage: invoke under the stage budget (+ contractual failover
   * grace), parse, schema-validate. Never throws.
   */
  private async stage<R extends AgentRole>(
    role: R,
    bundle: unknown,
    budgetMs: number,
    params: AgentGraphRunParams,
    collector: RunCollector,
    memoryIds: string[],
  ): Promise<StageOutcome<R>> {
    const prompt = this.deps.registry.get(role);
    let result: InvokeResult | typeof timeoutSentinel;
    try {
      result = await Promise.race([
        this.deps.llm.invoke({
          role,
          system: prompt.system,
          user: JSON.stringify(bundle),
          promptHash: prompt.hash,
          stageBudgetMs: budgetMs,
          signalId: params.signalId ?? undefined,
          retrievedMemoryIds: memoryIds,
        }),
        new Promise<typeof timeoutSentinel>((resolve) =>
          setTimeout(() => resolve(timeoutSentinel), budgetMs + this.budgets.failoverGraceMs),
        ),
      ]);
    } catch (err) {
      const reason: HoldReason =
        err instanceof LlmExhaustedError ? 'PROVIDER_EXHAUSTED' : 'STAGE_TIMEOUT';
      return {
        ok: false,
        failure: { reason, detail: err instanceof Error ? err.message : String(err) },
      };
    }
    if (result === timeoutSentinel) {
      return {
        ok: false,
        failure: { reason: 'STAGE_TIMEOUT', detail: `${role} exceeded ${budgetMs}ms (+grace)` },
      };
    }
    collector.costUsd += result.costUsd;
    collector.llmCalls += 1;

    let parsed: unknown;
    try {
      parsed = parseJsonObject(result.text);
    } catch (err) {
      return {
        ok: false,
        failure: {
          reason: 'SCHEMA_INVALID',
          detail: `${role}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const validated = validateAgentOutput(role, parsed);
    if (!validated.ok) {
      return {
        ok: false,
        failure: { reason: 'SCHEMA_INVALID', detail: `${role}: ${validated.error}` },
      };
    }
    return { ok: true, value: validated.value };
  }

  async run(params: AgentGraphRunParams): Promise<AgentGraphResult> {
    const collector = new RunCollector();
    const { assembler } = this.deps;
    const { prepared } = params;
    const budgets = this.budgets;
    const stage = this.stage.bind(this);
    const pThreshold = this.pThreshold;
    const rounds = prepared.pipeline.debateRounds;

    const GraphState = Annotation.Root({
      technical: Annotation<SpecialistOutput | null>({ reducer: (_, b) => b, default: () => null }),
      macro: Annotation<SpecialistOutput | null>({ reducer: (_, b) => b, default: () => null }),
      sentiment: Annotation<SpecialistOutput | null>({ reducer: (_, b) => b, default: () => null }),
      round: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
      tiebreakerApplied: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
      tiebreakerOverrode: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
      trader: Annotation<TraderOutput | null>({ reducer: (_, b) => b, default: () => null }),
      risk: Annotation<RiskTeamOutput | null>({ reducer: (_, b) => b, default: () => null }),
      digest: Annotation<DebateDigest | null>({ reducer: (_, b) => b, default: () => null }),
      pm: Annotation<PmOutput | null>({ reducer: (_, b) => b, default: () => null }),
      failure: Annotation<StageFailure | null>({ reducer: (_, b) => b, default: () => null }),
    });
    type S = typeof GraphState.State;

    const specialistsOf = (state: S): SpecialistOutputs => ({
      technical: state.technical ?? NEUTRAL('missing'),
      macro: state.macro ?? NEUTRAL('missing'),
      sentiment: state.sentiment ?? NEUTRAL('missing'),
    });

    const degrade = (role: AgentRole, failure: StageFailure): SpecialistOutput => {
      collector.degraded.push(role);
      collector.notes.push(`${role} degraded to NEUTRAL: ${failure.reason} — ${failure.detail}`);
      return NEUTRAL(failure.reason);
    };

    // ── Specialists (parallel; single failure ⇒ NEUTRAL, never whole-graph HOLD)
    const specialistNode =
      (
        role: 'technical_analyst' | 'macro_analyst' | 'sentiment_analyst',
        key: 'technical' | 'macro' | 'sentiment',
        assemble: () => Promise<
          | { ok: true; input: { memories: Array<{ id: string }> } }
          | { ok: false; reason: HoldReason; detail: string }
        >,
      ) =>
      async (): Promise<Partial<S>> => {
        const bundle = await assemble();
        if (!bundle.ok) {
          return { [key]: degrade(role, { reason: bundle.reason, detail: bundle.detail }) };
        }
        const out = await stage(
          role,
          bundle.input,
          budgets.specialistMs,
          params,
          collector,
          bundle.input.memories.map((m) => m.id),
        );
        if (!out.ok) return { [key]: degrade(role, out.failure) };
        return { [key]: out.value as SpecialistOutput };
      };

    // ── One debate turn (bull or bear). Failed turn ⇒ skipped + noted. The
    // round counter advances after the bear turn REGARDLESS of success —
    // otherwise a failing bear would loop the debate forever (round never
    // increments ⇒ conditional edge keeps routing back to bull).
    const researcherNode =
      (role: 'bull_researcher' | 'bear_researcher', speaker: 'bull' | 'bear') =>
      async (state: S): Promise<Partial<S>> => {
        const advance: Partial<S> = speaker === 'bear' ? { round: state.round + 1 } : {};
        const bundle = await assembler.assembleResearcher(
          role,
          prepared,
          specialistsOf(state),
          collector.transcript,
          state.round,
        );
        if (!bundle.ok) {
          collector.notes.push(
            `round ${state.round} ${speaker} turn skipped: ${bundle.reason} — ${bundle.detail}`,
          );
          return advance;
        }
        const out = await stage(
          role,
          bundle.input,
          budgets.debateTurnMs,
          params,
          collector,
          bundle.input.memories.map((m) => m.id),
        );
        if (!out.ok) {
          collector.notes.push(
            `round ${state.round} ${speaker} turn skipped: ${out.failure.reason} — ${out.failure.detail}`,
          );
          return advance;
        }
        collector.transcript.push({
          round: state.round,
          speaker,
          argument: out.value.argument,
          confidence: out.value.confidence,
        });
        return advance;
      };

    // ── Trader (split vote ⇒ QUANT_DEFAULT, code-enforced)
    const traderNode = async (state: S): Promise<Partial<S>> => {
      const lastOf = (speaker: 'bull' | 'bear') =>
        [...collector.transcript].reverse().find((t) => t.speaker === speaker) ?? null;
      const bull = lastOf('bull');
      const bear = lastOf('bear');
      const mode = tiebreakerMode(bull?.confidence ?? null, bear?.confidence ?? null);

      const bundle = await assembler.assembleTrader(
        prepared,
        specialistsOf(state),
        collector.transcript,
        mode,
      );
      if (!bundle.ok) {
        return { failure: { reason: bundle.reason, detail: bundle.detail } };
      }
      const out = await stage(
        'trader',
        bundle.input,
        budgets.stageMs,
        params,
        collector,
        bundle.input.memories.map((m) => m.id),
      );
      if (!out.ok) return { failure: out.failure };

      if (mode !== 'QUANT_DEFAULT') return { trader: out.value, tiebreakerApplied: false };

      // §9.6: never unstructured LLM discretion on a split vote.
      const quantDefault: TraderOutput =
        prepared.candidate.probability >= pThreshold
          ? {
              action: 'ENTER',
              direction: prepared.candidate.side,
              confidence: prepared.candidate.probability,
            }
          : { action: 'HOLD', direction: null, confidence: prepared.candidate.probability };
      const conforms =
        out.value.action === quantDefault.action &&
        (quantDefault.action !== 'ENTER' || out.value.direction === quantDefault.direction);
      if (!conforms) {
        collector.notes.push(
          `tiebreaker QUANT_DEFAULT overrode trader output ${JSON.stringify(out.value)} (P=${prepared.candidate.probability}, threshold=${pThreshold})`,
        );
      }
      return {
        trader: conforms ? out.value : quantDefault,
        tiebreakerApplied: true,
        tiebreakerOverrode: !conforms,
      };
    };

    // ── Risk team
    const riskNode = async (state: S): Promise<Partial<S>> => {
      if (state.trader === null) return {}; // upstream failure already recorded
      const bundle = await assembler.assembleRiskTeam(prepared, state.trader, params.account);
      if (!bundle.ok) return { failure: { reason: bundle.reason, detail: bundle.detail } };
      const out = await stage(
        'risk_team',
        bundle.input,
        budgets.stageMs,
        params,
        collector,
        bundle.input.memories.map((m) => m.id),
      );
      if (!out.ok) return { failure: out.failure };
      return { risk: out.value };
    };

    // ── PM (deterministic digest — ADR-011)
    const pmNode = async (state: S): Promise<Partial<S>> => {
      if (state.trader === null || state.risk === null) return {};
      const lastOf = (speaker: 'bull' | 'bear') =>
        [...collector.transcript].reverse().find((t) => t.speaker === speaker) ?? null;
      const bull = lastOf('bull');
      const bear = lastOf('bear');
      const digest = buildDigest({
        specialists: specialistsOf(state),
        finalBull: bull ? { argument: bull.argument, confidence: bull.confidence } : null,
        finalBear: bear ? { argument: bear.argument, confidence: bear.confidence } : null,
        trader: state.trader,
        risk: state.risk,
        tiebreakerApplied: state.tiebreakerApplied,
        degradedRoles: collector.degraded,
      });
      const bundle = await assembler.assemblePm(prepared, state.risk, state.trader, digest);
      if (!bundle.ok) return { digest, failure: { reason: bundle.reason, detail: bundle.detail } };
      const out = await stage(
        'pm',
        bundle.input,
        budgets.stageMs,
        params,
        collector,
        bundle.input.memories.map((m) => m.id),
      );
      if (!out.ok) return { digest, failure: out.failure };
      return { digest, pm: out.value };
    };

    // ── Wiring. Node names deliberately differ from state channel names —
    // LangGraph 1.x rejects a node named like a channel ('technical', 'pm' …).
    const graph = new StateGraph(GraphState)
      .addNode(
        'technical_analyst',
        specialistNode('technical_analyst', 'technical', () =>
          assembler.assembleTechnical(prepared),
        ),
      )
      .addNode(
        'macro_analyst',
        specialistNode('macro_analyst', 'macro', () => assembler.assembleMacro(prepared)),
      )
      .addNode(
        'sentiment_analyst',
        specialistNode('sentiment_analyst', 'sentiment', () =>
          assembler.assembleSentiment(prepared),
        ),
      )
      .addNode('join', async () => ({}))
      .addNode('bull', researcherNode('bull_researcher', 'bull'))
      .addNode('bear', researcherNode('bear_researcher', 'bear'))
      .addNode('trader_stage', traderNode)
      .addNode('risk_stage', riskNode)
      .addNode('pm_stage', pmNode)
      .addEdge(START, 'technical_analyst')
      .addEdge(START, 'macro_analyst')
      .addEdge(START, 'sentiment_analyst')
      .addEdge(['technical_analyst', 'macro_analyst', 'sentiment_analyst'], 'join')
      .addConditionalEdges('join', () => (rounds === 0 ? 'trader_stage' : 'bull'), [
        'trader_stage',
        'bull',
      ])
      .addEdge('bull', 'bear')
      .addConditionalEdges('bear', (state) => (state.round < rounds ? 'bull' : 'trader_stage'), [
        'bull',
        'trader_stage',
      ])
      .addConditionalEdges('trader_stage', (state) => (state.failure ? END : 'risk_stage'), [
        'risk_stage',
        END,
      ])
      .addConditionalEdges('risk_stage', (state) => (state.failure ? END : 'pm_stage'), [
        'pm_stage',
        END,
      ])
      .addEdge('pm_stage', END)
      .compile();

    // ── Full-graph budget (§2.2: 120s ⇒ HOLD, partial transcript persisted)
    let finalState: S | typeof timeoutSentinel;
    try {
      finalState = await Promise.race([
        graph.invoke({}) as Promise<S>,
        new Promise<typeof timeoutSentinel>((resolve) =>
          setTimeout(() => resolve(timeoutSentinel), budgets.graphMs),
        ),
      ]);
    } catch (err) {
      finalState = timeoutSentinel;
      collector.notes.push(`graph error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const base = {
      transcript: collector.transcript,
      notes: collector.notes,
      degradedRoles: [...collector.degraded].sort(),
      costUsd: collector.costUsd,
      llmCalls: collector.llmCalls,
    };

    if (finalState === timeoutSentinel) {
      return {
        ...base,
        decision: 'HOLD',
        holdReason: 'BUDGET_EXCEEDED',
        holdDetail: `agent graph exceeded ${budgets.graphMs}ms (or errored) — partial transcript retained`,
        specialists: {
          technical: NEUTRAL('graph budget'),
          macro: NEUTRAL('graph budget'),
          sentiment: NEUTRAL('graph budget'),
        },
        tiebreakerApplied: false,
        tiebreakerOverrode: false,
        trader: null,
        risk: null,
        digest: null,
        pm: null,
      };
    }

    const specialists = specialistsOf(finalState);
    if (finalState.failure || finalState.pm === null) {
      const failure = finalState.failure ?? {
        reason: 'SCHEMA_INVALID' as HoldReason,
        detail: 'graph ended without a PM decision',
      };
      return {
        ...base,
        decision: 'HOLD',
        holdReason: failure.reason,
        holdDetail: failure.detail,
        specialists,
        tiebreakerApplied: finalState.tiebreakerApplied,
        tiebreakerOverrode: finalState.tiebreakerOverrode,
        trader: finalState.trader,
        risk: finalState.risk,
        digest: finalState.digest,
        pm: null,
      };
    }

    return {
      ...base,
      decision: finalState.pm.decision,
      holdReason: null,
      holdDetail: null,
      specialists,
      tiebreakerApplied: finalState.tiebreakerApplied,
      tiebreakerOverrode: finalState.tiebreakerOverrode,
      trader: finalState.trader,
      risk: finalState.risk,
      digest: finalState.digest,
      pm: finalState.pm,
    };
  }
}
