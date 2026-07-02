# Critical Review — FX Trading Platform Plan v2.1

*Review date: 1 July 2026 · Covers: Development Plan index, System Design v2.1, BE stories v2.1, QN stories v2.1, FE stories v2.0*

**Verdict: not perfect — but close to build-ready.** The v2.1 robustness recommendations were incorporated well and consistently across the system design and BE/QN stories. However, this review found **1 architecture-breaking error, 5 blocking issues, and a set of high/medium gaps** that should be fixed before Phase 1 starts. The strongest parts of the plan (deterministic risk gate, shadow baseline, provenance/replay, point-in-time discipline, ablation harness, ADR log) are genuinely good and should not change.

---

## 1. CRITICAL — Neon Postgres cannot run your TimescaleDB features (ADR-006 conflicts with BE-020)

ADR-006 moves production Postgres to **Neon**, but Neon ships only the **Apache-2 edition** of TimescaleDB. That edition includes hypertables and `time_bucket`, but **excludes continuous aggregates, columnar compression, and retention policies** — all TSL-licensed features.

Your plan depends on exactly those features:

- §7.1: "Continuous aggregates: M5 → H4 → D1"
- BE-020 acceptance criteria: "CAGGs refresh and retention policies set"
- Tick retention policy (§7.1 `ticks` table)

**As written, BE-020 will fail on the production database.** Options, in rough order of preference for your scale:

1. **Self-hosted TimescaleDB (community edition) on a dedicated Hetzner volume, outside the Swarm stack.** Preserves the full feature set and the ADR-006 isolation intent (separate volume, own lifecycle, documented backup SLA). You already run this exact image in dev, so dev/prod parity is perfect. Neon can still host the *relational* side if you want, but splitting the DB in two adds complexity for little gain at single-user scale.
2. **Timescale Cloud** — full features, managed, but another vendor and cost.
3. **Stay on Neon, drop TimescaleDB semantics** — native Postgres partitioning + `pg_partman` + scheduled rollup jobs replacing CAGGs. Viable but you rewrite BE-020 and lose compression on ticks.

Whichever you choose, update ADR-006, §2 topology, §12, BE-004, BE-020, and BE-142 together — right now §2's data plane box says "Neon Postgres + TimescaleDB (managed)" which is not a purchasable thing. Note pgvector (agent memory) **is** supported on Neon, so if you choose option 1, decide whether memory lives in the same self-hosted instance (simplest: yes).

Source: [Neon docs — timescaledb extension](https://neon.com/docs/extensions/timescaledb)

---

## 2. BLOCKING — The LangGraph timeout budget doesn't arithmetic out

§2.2 gives the full graph **120s** (H1) and each agent call **30s**. But the graph is mostly sequential: 3 specialists → bull → bear (×1–2 debate rounds) → trader → risk team → PM. Worst case at 2 debate rounds is **9–11 sequential LLM calls**. At the 30s per-call ceiling that's 270–330s — 2.5× the graph budget. Worse, §9.4 failover says a timed-out call (30s) immediately retries on the next provider *within the same call attempt*, so one bad call can legally consume 60s+.

This won't bite on the happy path (typical calls are 2–8s), but the budgets are supposed to be *worst-case guarantees*, and right now the worst case of one stage exceeds the budget of its parent. Fixes:

- State explicitly that the **3 specialists run in parallel** (they have disjoint inputs per §9.6, so this is free).
- Give each stage its own sub-budget that sums to ≤120s (e.g., specialists 20s parallel, each debate round 30s, trader 15s, risk 15s, PM 15s), with per-stage overrun → that stage outputs HOLD/NEUTRAL rather than killing the whole graph.
- Cap failover retries to **one** fallback attempt with a reduced timeout (e.g., 10s), not a fresh 30s.
- Note that at high regime uncertainty (auto 2 rounds) the graph is *slowest exactly when markets are most stressed* — the worst time to blow the budget. Worth a chaos test: 2-round debate + one degraded provider, assert end-to-end <180s.

---

## 3. BLOCKING — No deterministic gate before the agent graph fires (cost + latency blowup)

BE-080 wisely gates *supervision* LLM calls ("LLM runs only when material change detected"). The **entry path has no equivalent**. §2.1 and BE-066 read as: every H1 bar close → gRPC pipeline → full LangGraph run. With ~8 instruments × 24 H1 bars/day, that's ~190 full multi-agent graph runs daily — most of them on bars where the quant core has no candidate at all.

Make explicit what is probably intended: **the LangGraph graph runs only when the quant pipeline emits a candidate** (non-flat direction, and arguably P ≥ some pre-filter below the 0.60 entry threshold, e.g., 0.50). Bars with no candidate short-circuit to HOLD with zero LLM cost, logged as `gate_skip` like BE-080. Add this as an acceptance criterion on BE-066 and a line in §2.1. This also makes the concurrency-cap problem (below) mostly disappear, since simultaneous candidates across 3+ instruments are rare.

Related: define when the E2E 180s clock starts for jobs queued behind the concurrency semaphore. If 6 instruments produce candidates at the same bar close, batch 2 waits ~120s before starting and will breach 180s from enqueue — meaning low-liquidity instruments would *systematically* HOLD every contested bar. Start the E2E budget at semaphore acquisition, or stagger instrument evaluation within the bar.

---

## 4. BLOCKING — Kill-switch state lives in a Redis flag

§13.2: kill-switch sets "audit log + Redis flag." If Redis restarts (or loses unpersisted state), the kill-switch flag can silently vanish while workers resume. For the single most safety-critical control in the system:

- **Persist kill-switch state in Postgres** as the source of truth; Redis holds only a fast-path cache that workers re-hydrate from DB on boot and on cache miss.
- Specify Redis persistence (AOF `everysec` minimum) — BullMQ's "durable" job semantics also depend on this, and it's currently unstated.
- Kill-switch close-out has no partial-failure path. BE-050's partial-fill logic covers *entries* only. If closing 5 positions and OANDA rejects/partially fills one, what happens inside the <2s target? Specify: retry loop with escalating alerts, never report "closed" until broker-confirmed flat, reconciler as backstop.

Same gap for order **rejections** generally: only `fill_qty < requested_qty` is specified. Add explicit handling for REJECTED / INSUFFICIENT_MARGIN / MARKET_HALTED reason codes in BE-050.

---

## 5. BLOCKING — Dead-man's switch placement is unspecified

BE-053's watchdog is only meaningful if it runs **off-host**. A watchdog on the same single-node Hetzner Swarm dies with the host — exactly the failure it exists to catch. Specify: a minimal external process (cheap VPS in another provider/region, or even a scheduled GitHub Action as poor-man's version) holding its **own scoped OANDA token**, watching a heartbeat endpoint, able to flatten positions directly via the OANDA REST API without touching your stack. This deserves its own acceptance criteria: "Given the entire Hetzner host is unreachable, when heartbeat times out, then watchdog flattens via broker API within N minutes."

---

## 6. BLOCKING — The dependency graph has cycles and wrong targets

Import into a tracker as-is and Phase 1 deadlocks:

- **BE-050 ↔ BE-080 is circular.** BE-050 (execution worker, Phase 2) lists BE-080 (supervision queue, Phase 4) as a dependency, while BE-080 depends on BE-050. BE-050's dependency is wrong — remove it (Phase 2 cannot depend on Phase 4).
- **QN-020 (Phase 1) depends on QN-032 (Phase 2).** The streaming feed needs OANDA *connection* code, not the full execution adapter. Split a small "OANDA client/auth/stream" story into Phase 1, or reverse the dependency.
- Several FE dependencies point at unrelated stories, apparently off-by-a-block: FE-040 and FE-070 → BE-080 (should be BE-054 trades endpoints), FE-050 → BE-060 (should be BE-045 market endpoints), FE-060 → BE-070 (should be BE-067 signals REST/WS), FE-090 → BE-060 (should be QN-055), FE-102 → BE-120 (should be BE-130), FE-120 → BE-115 (should be BE-014/BE-117).
- BE-013 (Phase 1) asserts "Given authenticated request" but JWT middleware (BE-030) is Phase 5. Fine in practice (internal token / dev bypass) but state the Phase 1 auth stand-in explicitly.

Do a full pass over every `Dependencies` line before tracker import.

---

## 7. HIGH — Agent memory: reflections are written before the outcome exists

§9.5's write protocol runs the reflection node **after the PM decision** — i.e., it records *what the agents argued*, not *whether they were right*. TradingAgents' memory value comes from reflecting on **realized P&L**. Without outcome linkage, retrieval surfaces confident-sounding past rationales with no signal about their quality — a recipe for self-reinforcing bias.

Add to BE-064:

- **Second write on trade close** (or candidate expiry): update/append the reflection with realized outcome (R-multiple, hit SL/TP, holding period). Retrieval can then weight or annotate memories by outcome.
- **Memory hygiene:** max store size per instrument, dedup near-identical reflections, and a decay/eviction policy. Unbounded top-K cosine over an ever-growing store of self-generated text degrades quietly.
- **Pin and version the embedding model** in the schema (`embedding_model` column). Swapping models silently invalidates every stored vector.
- **Store `retrieved_memory_ids` on each `agent_runs` row.** QN-062's deterministic replay is impossible otherwise — you can't reproduce an agent's context without knowing which memories it saw.
- **Extend BE-063's red-team suite with a memory-persistence attack:** an injected headline that manipulates the *reflection* poisons every future bar, not just one. Assert that reflections derived from adversarial fixtures don't propagate instructions.

---

## 8. HIGH — Agentic backtesting doesn't fit the vectorbt engine

vectorbt is vectorized; agents + memory are inherently **sequential** (bar N's memory depends on bars 1…N-1's decisions). QN-050 can only backtest the quant core. There is no story for the **event-driven, bar-by-bar simulation loop** that QN-052's cached-LLM/live-LLM modes and BE-064's backtest-memory criteria require. Add a QN story: event-driven agentic backtest runner that (a) rebuilds memory incrementally and deterministically during the run, (b) uses the same LangGraph code path (design principle #2), (c) reconciles its quant-core results against vectorbt as a correctness check. Also note the cache implication: once memory injects per-bar context, `prompt_hash` changes every bar — cached-LLM reproducibility must key on (prompt template version + inputs), and live cost control cannot rely on prompt caching.

---

## 9. HIGH — Correlation clustering is placed in the wrong service, and weekly refresh is too slow

BE-071 has the Node `risk-gate` package computing a rolling Pearson matrix + hierarchical clustering — but §3.1 says "**Node never does maths**." Move computation to Python (new QN story alongside QN-047); risk gate *consumes* a cluster table. And the stated motivation for the story — "correlation between EUR/USD and GBP/USD can change significantly during risk-off events" — is not answered by a **weekly** refresh. Add an event-triggered recompute: on `liquidity_regime` transition or realized-vol spike, refresh clusters immediately and re-evaluate open exposure.

---

## 10. HIGH — Session logic breaks twice a year (DST)

QN-040 emits `session_label` "per FX session boundaries" from the UTC hour, and QN-047 keys rollover at "Wednesday 22:00 UTC." London opens 08:00 *local* (07:00 UTC in summer, 08:00 UTC in winter); NY rollover is 17:00 New York time (21:00 UTC summer, 22:00 UTC winter); Sydney shifts opposite. Fixed UTC boundaries are wrong for roughly half the year, corrupting exactly the session features v2.1 added. Specify sessions and rollover in **exchange-local time zones with DST-aware conversion** (IANA tz database), and add an acceptance criterion testing a summer bar and a winter bar. The Friday-close gap-flatten window (BE-070: "Friday 20:00 UTC") has the same defect.

---

## 11. HIGH — Nobody owns context assembly

§9.6 defines *what* each agent receives but not **who assembles it**. The sentiment analyst needs raw headlines (the untrusted-data block) — but gRPC `RunPipeline` returns features/regime/candidate only, and headlines live in `news_archive`. Similarly, the PM receives a "debate summary… not full transcript" — **who produces that summary?** A 9th LLM call? The trader? Deterministic truncation? Each answer has different cost, latency, and injection-surface implications (an LLM summarizer is itself injectable and must be inside the BE-063 test scope).

Add a story for a **context-assembler** in the signal worker: fetches headlines (point-in-time filtered), retrieves memories, partitions features per §9.6, validates each bundle against `AgentContextContract` *before* invocation. Make the PM-summary mechanism an explicit design decision.

---

## 12. MEDIUM — Internal contradictions to reconcile

- **Circuit breaker:** §2.2 says "half-open after 60s" *and* "open for 2 min" in the same line; BE-068 says half-open after 2 min. Pick one.
- **Failover chain:** §9.4 table ends at OpenAI; BE-060 notes say "Anthropic → OpenRouter → OpenAI → Gemini." Align, and reconsider hardcoding "`gpt-4o-mini` tier" as the downgrade target in a provider-abstracted design — express it as a capability tier, not a model name.
- **Downgraded runs during the 90-day paper window:** §9.4 excludes downgraded runs from live-promotion evidence. A week-long provider incident during the paper run could invalidate a large slice of the 90 days. Define a policy: max % downgraded bars tolerated, else extend the window.
- **Paging:** §12.1 says "page" repeatedly, but the notification stack is Telegram + email. Either add a real escalation channel (resolves open question #2 — yes, add SMS or a paging service for critical alerts) or rename to what it is.
- **MetaTrader5 Python package is Windows-only.** Harmless since MT5 is off the critical path (ADR-005), but QN-031's acceptance criteria can't run in the Linux Docker image or CI as written — mark it as requiring a Windows test env, or descope to "interface conformance via mock."

---

## 13. MEDIUM — Frontend stories were never updated to v2.1

The FE file is still v2.0 (2026-06-28) and has no stories for surfacing the new machinery: circuit-breaker state, liquidity regime, session labels, `model_downgraded` flags, partial-fill notifications, agent-memory inspection (what memories informed this decision — important for the audit story), debate-depth indicator, and the new settings (correlation clustering params, session multipliers, gap-flatten toggles, per-instrument loss limits). FE-100 and FE-060 need scope updates; likely 2–3 new small stories. Also several risk features are configured but invisible — an operator can't verify the Wednesday-rollover flag or gap-flatten arming without UI.

---

## 14. MEDIUM — Operational and safety odds-and-ends

- **TOTP recovery codes are missing.** Lose the phone → locked out of the kill-switch, live-mode toggle, and broker-cred writes. Add recovery codes at enrollment (BE-036/FE-035) plus a documented break-glass procedure.
- **Per-instrument daily loss (2%) interaction:** three instruments each down 2% = 6%, but the 5% daily halt binds first — fine, just document that the instrument limit is an *early-warning* tripwire, not additive headroom.
- **Compliance footnote:** automated execution on an invited user's own account (not just the operator's) may still constitute regulated portfolio management in the UK even with no pooled money. Harmless while single-user; flag it as a hard stop before inviting anyone else to connect a broker.
- **Load test story:** §2.2 promises the pipeline is "tested under load," and BE-066 covers 3+ instruments, but no story exercises worst-case: all instruments candidate simultaneously + 2-round debates + one degraded provider. Fold into BE-120.

---

## 15. What's right (keep as-is)

The deterministic risk-gate-as-final-authority design, shadow baseline with net-of-LLM-cost promotion gate, full decision provenance with replay (QN-062), point-in-time discipline as a build-breaking defect, the ablation harness (memory on/off, debate sweep), disagreement-cohort logging, champion/challenger, canary ramp, and the ADR log are all better than most production trading systems ever get. ADR-005 (OANDA sole venue) is the correct call and cleanly executed across the docs. The v2.1 agent context contracts (§9.6) are specific enough to be testable — a real improvement over TradingAgents' ad-hoc prompt passing.

---

## Suggested new/modified stories (summary)

| Action | Story | Description |
|---|---|---|
| Rewrite | ADR-006, BE-020, BE-004, BE-142 | Resolve TimescaleDB/Neon conflict (§1) |
| Modify | §2.2, BE-066 | Per-stage sub-budgets; parallel specialists; capped failover retry (§2) |
| Modify | BE-066, §2.1 | Deterministic entry gate before agent graph; E2E clock start (§3) |
| New | BE-073 | Kill-switch state in Postgres + Redis AOF + close-out partial-failure handling (§4) |
| Modify | BE-050 | Order rejection reason-code handling (§4) |
| Modify | BE-053 | Off-host watchdog with own broker token (§5) |
| Fix | all story files | Dependency-graph pass: cycles + wrong targets (§6) |
| Modify | BE-064, BE-063 | Outcome-linked reflection, hygiene, embedding versioning, `retrieved_memory_ids`, memory-poisoning red-team (§7) |
| New | QN-056 | Event-driven agentic backtest runner (§8) |
| New / modify | QN-048, BE-071 | Clustering computed in Python; event-triggered refresh (§9) |
| Modify | QN-040, QN-047, BE-070 | DST-aware sessions/rollover/Friday close (§10) |
| New | BE-06x | Context assembler + PM-summary mechanism decision (§11) |
| Fix | §2.2/BE-068, §9.4/BE-060 | Contradictions (§12) |
| Update | FE stories → v2.1 | Surface new machinery + settings (§13) |
| Modify | BE-036, FE-035 | TOTP recovery codes (§14) |

---

*Sources: plan documents in this project; [Neon docs — timescaledb extension](https://neon.com/docs/extensions/timescaledb).*
