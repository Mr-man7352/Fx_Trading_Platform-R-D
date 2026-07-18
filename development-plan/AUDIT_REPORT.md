# Project Audit — FX Trading Platform

**Date:** 17 July 2026 · **Scope:** all 6 phases (plan completeness, code quality & tests, security & config) · **Baseline:** commit `9ef8f83` (2026-07-14), working tree clean vs `origin/main`.

## Verdict

The build is **code-complete across all six phases and fully committed**. Story coverage is 131/134 IDs traceable in code (the 3 gaps are cosmetic, see below), all 9 Prisma migrations including `step_6_go_live_tables` are in the tree, and the 2026-07-14 unit gate (vitest 401/401, pytest 291/291, mypy --strict, ruff) ran against exactly this tree — nothing has changed since, so those results remain representative. What stands between here and live is not missing code: it is the champion retrain, the staging/runtime drills, and the 90-day paper window — plus one security finding worth fixing first (kill-switch deactivation, F-1).

## 1. Plan-vs-code completeness

Every story ID from `FX_PRD.md` and the three story files was cross-referenced against the codebase (excluding `development-plan/`). 131 of 134 planned IDs appear in code, comments, or infra; QN-031 (MT5 adapter) was formally dropped 2026-07-06. The three unreferenced IDs are all actually implemented, just never tagged:

| ID | Status |
|---|---|
| FE-001 (bootstrap Turborepo) | Trivially satisfied — the monorepo exists. |
| FE-032 (email/password sign-in) | Implemented at `apps/dashboard/src/app/(auth)/sign-in/page.tsx`; no story-ID comment. |
| FE-111 (invite-only messaging) | Implemented in the auth layout/register/sign-in pages; no story-ID comment. |

Phase-6 deliverables verified present file-by-file: QN-060 `paper_validation.py` + `routes_validation.py`, BE-120 `chaos/chaos.test.ts` (S1–S8 scenarios), QN-062 `replay.py` + `routes_replay.py` + `GET /signals/:id/replay` (FE-060 transcript seam closed), QN-061 `risk_report.py` + `routes_report.py`, BE-122/BE-121 in `live-promotion.ts` / `settings.ts` / `signals-worker.ts` (canary clamp verified at lines 422–501) / `routes/trades.ts`, BE-132 `gdpr/` (service, ZIP writer, routes). Key safety claims were spot-verified in source: kill-switch state reads/writes Postgres (`killSwitchState` model, ADR-012), risk gate enforces `P ≥ minProbability` (ADR-008), canary ramp only engages in live mode below `CANARY_CONFIRM_FIRST_N`.

**Docs drift:** `DEVLOG_current.md` "Current state" still says Phase 6 is *uncommitted* and lists the migration as *owed*. Both are done (commit `9ef8f83`, migration `20260714205231_step_6_go_live_tables`). The devlog header should be updated so it stays the single source of truth.

## 2. Code quality & tests

Hygiene is unusually clean. Zero `@ts-ignore`/`@ts-expect-error` and zero `as any` outside tests; zero TODO/FIXME/HACK markers in non-test source; no god files (largest non-generated source is `signals-worker.ts` at 579 lines). All Python compiles clean in the sandbox (`compileall` over `app` + `tests`).

Test surface: 62 TS test files and 35 Python test files. The operator gate on 2026-07-14 recorded vitest 401/401 (including the 13-case chaos suite) and pytest 291/291 with mypy strict and ruff clean — and the tree is byte-identical since, so re-running was not required for this audit. CI (`ci.yml`) enforces check-env, Biome, vitest, ruff format+check, mypy strict, pytest, codegen drift (contracts + proto), Prisma schema-drift and destructive-SQL checks, and keeps the real vectorbt backend via the `vbt` group. The BE-063 red-team suite ships 29 patterns (AC: ≥ 20) including memory-persistence attacks.

Minor: ~35 `console.log` calls in non-test TS — nearly all in `scripts/` and worker bootstrap mains (`workers/*-main.ts`, `otel.ts`, `server.ts`) before Pino is up. Acceptable, but worth a sweep if you want uniform structured logs.

Known, documented gap (not a defect): `signals` does not persist the candidate's `model_version`, so QN-062 replay compares probability against the *current* champion and honestly marks it "not judged" after a registry change. Fine for now; persist `model_version` on signals if you want fully self-contained replays.

## 3. Security & config

Secrets hygiene is good: `.env` is untracked and correctly gitignored (`!.env.example` carve-out), no hardcoded secrets found in tracked files, `.env.example` contains placeholders only and passes `check-env --ci` (78 keys). Auth surface is coherent: NextAuth JWT + `x-internal-token`, global rate limit plus a dedicated limiter in `auth.ts`, Helmet + CORS from env, WS route authenticates in-handler (internal token or JWT with mid-session expiry close), and step-up 2FA guards password change, GDPR erasure, broker-credential writes, and live promotion. GDPR export correctly excludes hashes, sealed TOTP secrets, and credential ciphertexts. `TRADING_MODE=paper` locally — correct for the current stage.

Findings, in priority order:

**F-1 (medium) — kill-switch deactivation does not require 2FA.** In `routes/kill-switch.ts`, a *wrong* `twoFactorCode` blocks, but *omitting* the code passes — for both actions. For activation this is deliberate and well-reasoned (stopping trading is the fail-safe direction, documented in the route header). But **deactivation resumes trading** and currently rides the same policy. Recommend requiring fresh step-up (`requireStepUp` or mandatory verified code) on `action === 'deactivate'` before live.

**F-2 (low) — `/metrics` is publicly reachable in production.** The route is `public: true` with no auth, and the Caddyfile reverse-proxies the entire API host (`api.{$DOMAIN}`) to the internet — exposing queue depths, reconciliation-mismatch counts, trading mode, and commit hash. Recommend guarding it with the internal token or blocking the path in Caddy and letting Prometheus scrape over the internal network.

**F-3 (info) — Helmet CSP disabled** (`contentSecurityPolicy: false`). Acceptable for a JSON API; noted for completeness.

## 4. Go-live blockers (planned work, not defects)

These are the already-known items the plan itself gates on — restated here as the authoritative punch list. First, the **champion retrain**: the only trained model (`XAU_USD/H1 v1`, OOF AUC 0.51) has no edge, so the 90-day paper window — the schedule-critical path — cannot meaningfully start until a ≥ 18-month H1 retrain lands (PHASE2_TESTING_GUIDE §E). Second, the **owed drills**: PHASE6 guide §C staging drills, the Phase-4/5 runtime drills, and PHASE6 §D–§H at paper-window end. Third, the **pre-live seams** carried from Phase 5: broker equity sync must be real before live (currently baseline + realized P&L), the health-strip breaker needs its Redis mirror, the richer trade record over REST, and Python reading `platform_settings` knobs. BE-101's checklist correctly blocks live until QN-060 records a PASS and QN-061 stores a signed report — verified to flip on real DB evidence only.

## 5. Recommended next actions

Fix F-1 and F-2 (small, do them before anything live-facing), refresh the stale "Current state" block in `DEVLOG_current.md`, tag FE-032/FE-111 with story-ID comments for traceability, then proceed exactly as the plan says: retrain the champion, run guide §C and the Phase-4/5 drills, and start the paper window clock.
