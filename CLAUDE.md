# CLAUDE.md — stake_portfolio

Paper-trading agent app: Claude-powered "rounds" trade ASX/US shares with a fixed bankroll
(e.g. $50), and every sell that lifts cash above the starting balance gets the excess
**skimmed** into a profit ledger (worked example: $50 → buy $20 → sell for $40 → cash $70 →
skim $20 → cash back to $50). Rounds pause at their profit goal and can be chained.
Paper-first; real-money Stake trading is a far-future phase behind the same Broker interface.

## Authoritative documents (read before changing anything)

- **Spec:** `docs/superpowers/specs/2026-08-02-trading-agent-design.md` — approved by the user; §-references below point here.
- **Plans (executed in order, each = one feature branch):**
  1. `docs/superpowers/plans/2026-08-02-phase1-backend-engine.md` — engine (**merged to master**)
  2. `docs/superpowers/plans/2026-08-02-phase1-api-server.md` — API server (**merged to master**)
  3. `docs/superpowers/plans/2026-08-02-phase1-claude-decision.md` — Claude DecisionService (**merged to master**)
  4. Plan 4 (frontend React/Vite + Docker) — **not yet written**; write it with the writing-plans skill. This is the next step.

## CURRENT STATE (updated 2026-08-02)

- `master`: **Plans 1+2+3 all merged — 193 tests green, tsc + build clean.** Merge commit `5db001c`.
- No active feature branch. Phase 1 backend is functionally complete: engine → API → Claude agent.
- **Next: write Plan 4** (React/Vite frontend + Docker), then execute it with the same process below.
- What works end-to-end today: create a round via API → scheduler polls prices and fires
  protective stop-losses → scheduled/manual/CLI check-ins run a constrained Claude turn that
  trades through RoundService → skims bank profit → nightly job writes daily summaries and folds
  older history into a rolling abstract → ntfy notifies → SSE streams events.
- Not yet done: any UI (Plan 4), research briefings (spec phase 3), tax reporting (spec phase 4,
  REQUIRED before real-money Stake work), real Stake broker (spec phase 5).
- Live smoke path (requires host setup): `./scripts/setup-claude-auth.sh` → set ANTHROPIC_* env →
  `npm run cli -- create-user <name>` → create a round via the API → `npm run cli -- checkin <roundId>`.

## Execution process (established with the user — keep following it)

Subagent-driven development (superpowers skills: `writing-plans`, `subagent-driven-development`):

1. **One implementer subagent per plan task**, dispatched with a pointer to the plan section
   (plans live in-repo; don't paste full task text). Model: haiku for fully-specified/mechanical
   tasks, sonnet for integration-heavy ones. Implementers report DONE/BLOCKED etc.; they must
   NOT weaken tests — deviations require STOP-and-report, and legitimate plan bugs they fix
   get flagged as "sanctioned deviations" in later review prompts.
2. **Two-stage review per task**: spec-compliance first ("read code, don't trust the report"),
   then code-quality. Small pure-function tasks may use ONE reviewer doing both stages gated
   in order. Reviewer verdicts of "With fixes" → send fixes back to the SAME implementer agent
   (SendMessage), then re-review. Money-path code gets the full separate two-reviewer treatment.
3. **Whole-branch final review** before merging each plan branch (this caught real cross-file
   bugs per-task reviews missed — e.g. inverted stale-quote rules in Plan 1).
4. Merge with `--no-ff` into `master`, re-run suite, then next plan.
5. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (keep whatever
   model name applies). Never push — no remote exists.

**Test-count drift:** plan documents state expected totals; sanctioned extra tests (from review
fix rounds) shift them upward. Current authority: **193 on master**. Plan 3 finished at 193 vs a
planned 182 — the extra 11 are review-driven regression tests. When dispatching, tell implementers
to report the exact observed total rather than matching a stale target.

**Parallelism:** implementers/reviewers can run concurrently ONLY on disjoint file sets. Tell each
one exactly which files are theirs, to stage only those, and to retry on `.git/index.lock`. Do not
parallelize two agents that touch the same file.

## Repo layout / stack

- `backend/` — Node 22, TypeScript strict ESM (**NodeNext: imports use `.js` specifiers**),
  vitest (`backend/test/*.test.ts`), better-sqlite3 (WAL), express 5, argon2, supertest,
  yahoo-finance2 **v4** (class API: `new YahooFinance({suppressNotices:['yahooSurvey']})`),
  node-cron **v4**, cron-parser **v5** (`CronExpressionParser.parse`), zod 4,
  `@anthropic-ai/claude-agent-sdk` 0.3.x.
- `backend/src/`: `db/` (schema v1 in `migrations.ts` — 16 tables), `engine/` (PURE functions:
  skim, guardrails, fees — no I/O), `market/` (hours, MarketDataService, yahoo fetcher),
  `broker/` (PaperBroker), `rounds/` (RoundService — the money-integrity core),
  `scheduler.ts` (protective sweep), `settings/`, `auth/`, `api/` (buildApp + routes),
  `notify/` (ntfy), `agent/` (Plan 3: types, sdk-runner, personas, snapshot, [tools,
  decision, checkin-scheduler, summaries pending]).
- Frontend does not exist yet (Plan 4).

## Commands

```bash
cd backend
npm test               # vitest run (filter: npm test -- <name>)
npx tsc --noEmit       # typecheck (sdk-runner.ts is compile-checked only)
npm run build          # tsc → dist/
npm run dev            # tsx watch src/index.ts (needs DB_PATH/PORT env, defaults ok)
npm run cli -- create-user <name> | status   # checkin <roundId> arrives in P3 Task 8
```

## Hard-won invariants (violating these failed reviews before)

- **Money is integer AUD cents everywhere.** Quantities are float shares (ASX = whole shares).
  NO epsilon heuristics in money math — PaperBroker uses an exact integer-cents greedy top-up
  for ASX shares (`while (Math.round((qty+1)*priceAud*100) <= investableCents) qty++`).
  Buys must never spend > amountCents; sells must never exceed owned quantity.
- **Quote prices are untrusted input**: PaperBroker rejects non-finite/<=0 prices; top-up loop
  has a 100k iteration cap (a 1e-13 price once hung the process).
- **Stale-quote rules (spec §7):** new orders (agent AND operator) reject on `quote.stale`;
  stop-loss sells and scheduler stop-loss evaluation proceed on stale last-known prices.
- **Permission matrix** (`canTrade` in rounds/service.ts): agent trades only in `active`;
  operator in active/paused/takeover; stop_loss sell-only, non-terminal. Takeover = agent
  advisory-only (DecisionService offers ONLY write_journal + update_watchlist there).
- **buy()/sell() wrap broker + ledger + cash in one outer db.transaction**; rejected-order
  audit rows are written outside/after rollback. Trade fills also `logEvent('trade', ...)`.
- **Nested config objects (guardrails/fees) deep-merge** over defaults/current at create AND
  PATCH — a partial object must never wholesale-replace (undefined fields bypass `!== null`
  guardrail checks → NaN math).
- `startingBalanceCents` is IMMUTABLE mid-round (it's the skim baseline) — PATCH rejects it.
- **Files considered hardened** (touch only with surgical, review-flagged diffs):
  `engine/*`, `broker/paper.ts`, `rounds/service.ts`, `scheduler.ts`, `db/migrations.ts`.
- SSE (`/api/events/stream`) + NotificationDispatcher independently tail `event_log` by id
  cursor. Settings live in the `settings` table via SettingsStore namespaces.
- Auth: single user, argon2, httpOnly session cookie; every route gated except `/api/health`
  and login. `daily_summaries.day = 'abstract'` is a reserved slot for the lifetime summary.

## Claude/auth integration (Plan 3 specifics)

- **No API keys anywhere.** Subscription OAuth via OneCLI gateway (nanoclaw pattern):
  `scripts/setup-claude-auth.sh` (Task 8) captures `claude setup-token` → stores in OneCLI
  vault; backend env gets `ANTHROPIC_BASE_URL=<gateway>` + `ANTHROPIC_AUTH_TOKEN=placeholder`.
- The Agent SDK is imported in exactly ONE file: `src/agent/sdk-runner.ts`. Constraints are
  non-negotiable: `tools: []`, `permissionMode: 'dontAsk'`, `settingSources: []`,
  `allowedTools: ['mcp__trading__*']`, maxTurns default 6, env passthrough WITHOUT
  `ANTHROPIC_API_KEY` (explicitly stripped — it would outrank the proxy token).
- Everything else tests against `FakeAgentRunner` (backend/test/agent-helper.ts) — scripted
  tool calls against real handlers. Never add network calls to tests.
- Round `config.model` is a per-round experiment variable (default `claude-sonnet-5`).

## Deferred / tracked for later

- **Plan 4 must include:** cookie `secure` flag for TLS deploys, `trust proxy` note behind
  nginx (rate limiter), paused-round stop-loss configurability (spec §5.1, deferred from
  Plan 1 final review), rate-limiter map pruning. Spec §10 phases 2-5 (analytics, research
  briefings, tax reporting BEFORE any real-money Stake work) come after Phase 1.
- **Carried over from Plan 3 reviews (non-blocking, fix when convenient):**
  - `set_stop_loss` (agent/tools.ts) writes `positions.stop_loss_price` directly instead of via a
    `RoundService.setStopLoss()` method — works and violates no invariant, but it's the one agent
    write that touches a hardened table outside the service layer. Wrap it when adding stop-distance
    guardrails.
  - Daily digests bucket by **UTC** day while the product's timezone is Australia/Sydney, so a US
    overnight session can land on a day-label the user experiences as the next day. `index.ts`'s
    `sydneyYesterday()` picks the right day-string; the bucketing itself is still UTC. Revisit if
    summary day labels look off by one in the UI.
  - No `npm run setup-auth` alias; `scripts/setup-claude-auth.sh` is invoked directly.
  - Scheduler coalesces missed cron occurrences into one catch-up check-in (e.g. after laptop
    sleep) rather than firing each — deliberate, but note it if minute-level crons are ever added.
- User decisions on record: paper-first, both markets, scheduled check-ins, all guardrails
  configurable per round, kill switch pauses rounds (scheduler keeps protective stops running).
