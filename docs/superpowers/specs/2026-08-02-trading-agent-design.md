# Trading Agent — Design Spec

**Date:** 2026-08-02
**Status:** Approved pending user review
**Project:** stake_portfolio

## 1. Overview

An app that spins up Claude-powered trading agents ("rounds"). Each round starts
with a fixed bankroll (e.g. $50 AUD) and a profit goal (e.g. $1,000). The agent
analyses the share market on a schedule, buys and sells, and every time a sell
brings the cash balance above the starting bankroll, the excess is "skimmed"
(pocketed) into an external ledger. The working bankroll never grows beyond the
starting balance; accumulated skims measure success.

Trading is **paper-first**: real market prices, simulated fills, realistic fees.
Real-money trading on Stake is a later phase behind the same broker interface.

Guiding principle: **scripts do everything repeatable and deterministic; Claude
tokens are spent only on judgement.** Stop-losses, guardrails, skimming, data
collection, and charting never touch the model.

## 2. Core concepts

### 2.1 Round

A round is one experiment: config + ledger + agent. Multiple rounds run
concurrently, fully independent of each other.

Round config (all editable mid-run, see §2.6):

| Field | Example | Notes |
|---|---|---|
| starting_balance | $50 AUD | Working bankroll cap |
| profit_goal | $1,000 | Accumulated skims target |
| markets | ASX, US, or both | |
| watchlist | list of symbols | Agent can modify via tool |
| risk_profile | conservative / balanced / aggressive / custom | §2.4 |
| trading_style | day / swing / long | §2.5 |
| guardrails | per-guardrail on/off + params | §2.3 |
| checkin_schedule | cron-like, per market session | Defaults derived from trading_style |
| model | Claude model id | Experiment variable |
| prompt_persona | editable text blocks | Risk/style prompt sections, editable in dashboard |
| fees | ASX $/trade, US FX bps, slippage bps | Defaults: ASX $3, FX 70bps, slippage 0 |
| notifications | per-event toggles | §8 |

Round states: `active` → `paused` (manual or drawdown) → `active`;
`goal_reached` (auto-pause when skims ≥ goal); `busted` (cash and holdings
exhausted); `archived`. From `goal_reached`, a new round can be **chained**:
new starting balance/goal, optionally carrying over open positions at their
cost basis.

### 2.2 Skim rule (the heart of the app)

After every sell settles:

```
if cash > starting_balance:
    skim = cash - starting_balance
    record skim ledger entry
    cash = starting_balance
```

- Only **cash** counts — the value of open holdings never triggers a skim.
- Pocketed profit = sum of skim entries (append-only, auditable; never a
  mutable counter).
- Worked example (user's own): start $50 → buy $20 of shares (cash $30) →
  sell for $40 (cash $70) → skim $20 → cash back to $50, pocketed $20.
- Round reaches `goal_reached` when total skims ≥ profit_goal. Open positions
  are kept and may be carried into a chained round.

### 2.3 Guardrails (deterministic, run in scripts, all per-round configurable)

1. **Max per-position size** — a buy may not push a single symbol above X% of
   the working bankroll. Engine clips or rejects oversized agent orders.
2. **Stop-loss per position** — every buy gets an automatic sell trigger at
   −X% from cost (agent may set tighter via tool). Fires on price polls with
   no model involvement.
3. **Drawdown pause** — if total equity (cash + holdings) falls below X% of
   starting balance, pause the round and notify; operator decides to resume.
4. **Round ends at $0** — when cash and holdings are exhausted, round becomes
   `busted` and reports. The starting balance is the accepted max loss.

Guardrails validate **all** orders — agent and operator alike. Rejections and
clips are journaled so the agent sees them at its next check-in.

### 2.4 Risk profile

Presets `conservative` / `balanced` / `aggressive` / `custom`. A preset bundles:

1. **Behavioural prompt block** — conservative: large-caps/ETFs, longer holds,
   cash when unsure; aggressive: volatile small-caps, momentum, faster churn.
2. **Guardrail defaults** — e.g. conservative: 5% stop-loss, 25% max position,
   −20% drawdown pause; aggressive: 15% / 50% / −50%. Any value overridable;
   `custom` starts blank.

Prompt blocks live in config (editable from dashboard) so wording itself is an
experiment variable.

### 2.5 Trading style (separate axis from risk)

- **day** — open and close within a session; avoid overnight holds; several
  check-ins per session (higher token spend — surfaced in UI); wizard warns
  when combined with ASX fees on a small bankroll.
- **swing** — hold days-to-weeks; 1–2 check-ins/day. Default.
- **long** — hold weeks-to-months; check-in every 1–2 days; fundamentals- and
  trend-oriented prompt; cheapest in tokens.

Style sets prompt instructions + schedule defaults (overridable) and is a
dimension in comparison analytics.

### 2.6 Live config changes

- Every config field is editable mid-run; changes apply from the next
  poll/check-in.
- Each change is an append-only **config event** ("operator changed style:
  long → day") shown in round history, injected into the agent's next snapshot
  as an operator note, and drawn as a marker on charts.
- Analytics can segment a round into **config eras** so before/after
  performance is separable.
- Changes with immediate side effects (e.g. tightening a stop below current
  price) show a confirmation preview ("this will sell X now") before applying.

## 3. Architecture

Docker Compose, two containers + a volume:

- **backend** — Node 22 / Express / TypeScript. Scheduler, market data, rules
  engine, broker adapters, Claude decision service, notifier, REST API + SSE.
- **frontend** — React + Vite (TypeScript), static build served by nginx;
  Vite dev server with proxy in development.
- **SQLite** (better-sqlite3) on a named volume — single source of truth.

### 3.1 Backend modules

| Module | Responsibility |
|---|---|
| MarketDataService | Quotes + history via `yahoo-finance2` (US native, ASX via `.AX`). Caching, market-hours awareness (ASX 10:00–16:00 Australia/Sydney; US 9:30–16:00 America/New_York), staleness flags. Persists every poll. |
| Scheduler (`node-cron`) | Price polls during open sessions; guardrail evaluation on every poll; per-round check-in triggers. |
| RulesEngine | Pure functions: skim, stop-loss, position-size clip, drawdown, bust, fees, FX. No I/O. |
| BrokerAdapter | Interface: `PaperBroker` (fills at latest quote + slippage bps; fee model applied) now, `StakeBroker` (phase 4) later. Callers never know which. |
| DecisionService | Builds snapshot, one constrained Agent SDK turn per check-in, validates tool calls through RulesEngine, executes via broker, journals reasoning and token usage. |
| Notifier | ntfy HTTP POSTs behind a channel interface. |
| API | REST for CRUD/controls, SSE for live dashboard updates. |

### 3.2 Currency

Round bankroll is **AUD**. US trades convert at the live AUD/USD rate plus a
configurable FX fee (default 70 bps, mirroring Stake), so US "free brokerage"
is not artificially free in simulation. FX conversions are ledger entries.

### 3.3 Data model (SQLite)

`rounds`, `config_events`, `symbols`, `price_bars` (every poll + backfilled
history), `orders` (client-generated idempotency IDs), `trades` (fills),
`ledger_entries` (buy / sell / fee / fx / skim — append-only),
`equity_snapshots`, `checkins` (snapshot summary, tokens used, actions taken),
`journal_entries` (agent reasoning + operator notes), `daily_summaries`
(per-round digest + narrative, §4.3), `event_log` (errors, guardrail firings,
notifications sent).

## 4. Claude integration

### 4.1 Auth — OneCLI, no API key (nanoclaw pattern)

- One-time host-side `setup.sh` mirroring nanoclaw's `register-claude-token.sh`:
  installs OneCLI if missing, runs `claude setup-token` under a PTY to capture
  the subscription OAuth token (`sk-ant-oat…`), stores it via
  `onecli secrets create --name Anthropic --type anthropic --host-pattern api.anthropic.com`.
- The backend container holds **no secrets**: only
  `ANTHROPIC_BASE_URL=<OneCLI gateway>` and `ANTHROPIC_AUTH_TOKEN=placeholder`;
  OneCLI rewrites the Authorization header on the wire.
- Because subscription tokens target Claude Code surfaces, the DecisionService
  uses the **Claude Agent SDK** constrained to a single tight turn: snapshot in,
  in-process custom tools only, no file/bash access, capped turns. Billing
  flows through the Claude subscription.

### 4.2 Check-in contract

Snapshot (~1–2k tokens): cash; positions with cost basis, current price,
unrealised P/L, active stops; watchlist quotes with short trend stats; recent
trades; guardrail status; goal progress; **rolling history summary** (§4.3)
plus the last journal note (continuity of intent); operator notes/config
changes since last check-in; **research briefing slot** (empty until phase 3).

Agent tools (validated by RulesEngine before execution):

- `place_order(symbol, side, amount_aud)` — market orders only in v1.
- `set_stop_loss(symbol, stop_price | stop_pct)`
- `update_watchlist(add[], remove[])`
- `write_journal(note)` — reasoning, intent, plans for next check-in.

Failures of the Claude call skip the check-in (guardrails keep protecting);
retry next cycle.

### 4.3 Daily summaries & rolling history (agent memory)

At the close of each trading day a per-round summary job runs:

1. **Deterministic digest** (no tokens): trades executed, realised P/L, skims,
   equity change, guardrail events, config changes, tokens spent.
2. **Narrative** — one small Claude summarization call condenses the day's
   journal entries into a short "what I did, why, and what I'm watching
   tomorrow". If this call fails, the digest alone stands.

Both are stored per day in `daily_summaries`.

**Rolling history summary** (fed into every check-in snapshot): the last 7
daily summaries verbatim plus a periodically re-compressed round-lifetime
abstract of everything older. This gives the agent long memory of its own
behaviour at a near-constant token cost — one small summarization call per
active round per day, plus a weekly compression call.

**Dashboard:** each round gets a **Daily Summaries page** — a browsable list,
one entry per trading day, showing the narrative, the deterministic digest,
and links to that day's check-ins and journal entries, so the user can read
back through how the agent reached its decisions day by day.

## 5. Manual control

1. **Pause round** — stops check-ins and new agent orders; stop-losses keep
   firing while paused (configurable, default on).
2. **Global kill switch** — halts all rounds, cancels pending orders, stops
   the scheduler. Single confirmation.
3. **Takeover mode** — per-round: agent goes advisory-only (still journals at
   check-ins); operator trades via the same order form → same rules engine and
   ledger, so skims/history stay consistent. On release, the agent sees
   operator trades in its next snapshot as "operator action".

All controls exist as API endpoints (and thin CLI) so they work if the UI is
down.

## 6. Dashboard (React + Vite)

- **Rounds overview** — cards: state, equity sparkline, pocketed total, risk/
  style badges.
- **Round detail** — equity curve with buy/sell/skim/guardrail/config-change
  markers; pocketed-profit staircase toward goal; positions; trade + skim
  history; agent journal per check-in; **Daily Summaries page** (§4.3);
  settings panel (live edits); pause/takeover/kill controls; manual order
  form.
- **New round wizard** — config, presets, optional carry-over from a finished
  round; warns on foot-gun combos (e.g. day + ASX + small bankroll).
- **Markets page** — chart any tracked symbol (held or not): candles/line +
  volume, 1D/1W/1M/3M/all, moving-average and %-change overlays, markers for
  every round's trades on that symbol. Symbols remain polled after leaving a
  watchlist unless archived.
- **Analytics** —
  - Win rate, trade P/L histogram, avg win vs avg loss.
  - Hold-time vs return scatter.
  - Decision-outcome tracking: price N days after each buy/sell/pass
    ("sold too early?", "what did passing cost?").
  - Benchmark: round equity vs index-ETF-on-day-one over the same period.
  - Per-check-in ledger: tokens used, actions, linked reasoning.
  - Cross-round comparison overlays; config-era segmentation.
  - Fee/FX cost accumulation per round.
- Live updates via SSE.

## 7. Error handling

- **Claude call fails** → skip check-in, log, notify (configurable), retry
  next cycle. Deterministic protection unaffected.
- **Market data outage** → quotes flagged stale; new orders suppressed (never
  trade on stale prices); stop-losses evaluate on last-known price flagged
  stale; notify on prolonged outage.
- **Restart resilience** → all state in SQLite; scheduler rebuilds from DB on
  boot; orders idempotent via client-generated IDs (no double fills).
- All failures land in `event_log`, visible in the dashboard.

## 8. Notifications (ntfy)

- Notifier posts to configurable ntfy server/topic (ntfy.sh or self-hosted);
  channel interface allows other backends later.
- Events (global + per-round toggles): buy/sell executed, skim pocketed, goal
  reached, stop-loss fired, drawdown pause, round busted, data stale, check-in
  failed, operator actions.
- Priorities: trades = default; guardrail/goal = high; errors/busted = max.
- Messages include a short summary + link to the round's dashboard page.

## 9. Testing

- **RulesEngine**: pure-function unit tests — skim (including the §2.2 worked
  example), guardrails, fees, FX, clipping.
- **Integration**: fake clock, canned price feeds, scripted fake Claude
  (DecisionService behind an interface), in-memory SQLite.
- **Replay mode**: run a whole round deterministically against historical
  bars — doubles as a cheap backtester and a regression suite for strategy
  plumbing.
- Frontend: component tests for the order form and settings panel (the two
  places users can lose money by mistake).

## 10. Phases

1. **MVP (paper)** — single round end-to-end: market data + persistence,
   scheduler, rules engine, PaperBroker, OneCLI auth + DecisionService,
   dashboard (overview, round detail, markets charts, controls, wizard),
   ntfy, setup.sh, tests.
2. **Experiments** — concurrent rounds, full analytics suite, comparisons,
   config-era segmentation, replay/backtest mode.
3. **Research pass (Option C)** — scheduled/triggered deep-dives filling the
   research briefing slot: news around held/watched companies, r/wallstreetbets
   and general market sentiment, world events. Separate, budgeted agent run;
   output is a compact briefing consumed by normal check-ins.
4. **Tax reporting** — must land **before** any real-money trading: realised
   gains/losses per AU financial year (CGT-oriented), fee and FX summaries,
   exportable per round and across rounds. The append-only ledger already
   captures everything needed.
5. **Real money (StakeBroker)** — browser-automation adapter for Stake with
   site-navigation playbooks (scripted flows; Claude only handles judgement,
   never routine navigation), initial human-in-the-loop confirmation per
   trade, then graduated autonomy.

## 11. Risks

- **Not financial advice; expect to lose the bankroll.** The design treats the
  starting balance as the accepted max loss per round.
- **Yahoo Finance is an unofficial feed** — free but unguaranteed; the
  MarketDataService interface keeps a swap to another provider cheap.
- **Stake ToS / automation risk** (phase 5): browser automation of a brokerage
  is at the account holder's risk; deferred until the strategy earns trust in
  paper mode.
- **Delayed quotes**: free feeds may be delayed up to 20 min for ASX; fine for
  swing/long styles, a known limitation for day style in paper mode.

## 12. Future todo (post-launch roadmap)

Tax reporting is deliberately **not** on this list — it is promoted into §10
as phase 4, a hard prerequisite before the Stake real-money phase. Everything
below comes after real money ships, in rough priority order:

1. Options, crypto, and short selling support.
2. Margin trading.
3. Multi-user support (accounts, per-user rounds and notifications).
4. Alternative market-data providers (paid, real-time) if/when Yahoo's feed
   becomes a limitation.
