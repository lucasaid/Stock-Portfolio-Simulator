# Usage gate — design spec

**Date:** 2026-08-03
**Status:** approved by user, ready for planning

## Problem

This app fires AI (Claude Agent SDK) calls from three independent schedulers — check-ins
(`agent/checkin-scheduler.ts`), research briefings (`research/scheduler.ts`), and market-scan
(`market-scan/scheduler.ts`) — plus manual/CLI-triggered runs (`cli.ts checkin`, and any
manual "run now" API calls). None of these currently know or care about the account's
Claude subscription usage limits (the same session/weekly rate limits the interactive
Claude Code CLI's `/usage` command reports). The goal: stop firing AI calls once usage gets
close to those limits, and resume automatically once the limit window rolls over, without
requiring the user to babysit it.

## Data source

There is no documented, stable API for "current usage %". The interactive `/usage` slash
command is the only known source. It turns out to be scriptable and free:

```
$ claude -p "/usage" --output-format json
```

This is a **local, zero-cost** operation (`num_turns: 0`, `total_cost_usd: 0` in the response
— it never calls the model). The JSON's `.result` field is a text block containing, among
other things, two fixed-format lines:

```
Current session: 19% used · resets Aug 4 at 3:20am (Australia/Melbourne)
Current week (all models): 17% used · resets Aug 10 at 11am (Australia/Melbourne)
```

**Deployment feasibility (already solved by existing infra):** the Agent SDK bundles its own
`claude` binary and this app already wraps it for auth via
`backend/scripts/onecli-claude-wrapper.sh` (baked into `backend/Dockerfile`'s runtime stage,
referenced as `pathToClaudeCodeExecutable` in `agent/runner-options.ts`). The usage checker
reuses this exact same wrapper script — no new binary, no new auth path, no new Docker
changes.

Reset timestamps (`"Aug 4 at 3:20am (Australia/Melbourne)"`) are **display-only** — they are
never parsed into a `Date` or used to schedule a resume. Resuming happens implicitly: once
the cache TTL (below) expires and the account's window has actually rolled over, the next
poll reports a lower percentage and gate checks pass again on their own.

## Architecture

A new `UsageGateService` (backend/src/agent/usage-gate.ts) sits in front of the three AI-call
entry points. Each entry point calls it first; if blocked, the call is skipped entirely (the
underlying `AgentRunner.run` is never invoked — zero cost, zero partial state).

```
DecisionService.runCheckin        ─┐
ResearchService.runBriefing       ─┼─► UsageGateService.check() ─► allowed? proceed : log + skip
MarketScanService.runScan         ─┤
cli.ts `checkin` command          ─┘
```

No new DB table/migration — thresholds live in `SettingsStore` (a new namespace, same
pattern as `integrations`/`notifications`); the live usage snapshot is transient
in-memory state, not persisted.

### `UsageChecker` interface (mirrors the existing `AgentRunner`/`FakeAgentRunner` split)

```ts
interface UsageSnapshot {
  sessionPct: number | null;
  sessionResetsAt: string | null; // raw display string, e.g. "Aug 4 at 3:20am (Australia/Melbourne)"
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
}

interface UsageChecker {
  checkUsage(): Promise<UsageSnapshot>;
}
```

- **`ClaudeCliUsageChecker`** (real impl): `execFile`s the same wrapper script
  `runner-options.ts` already points the SDK at (`CLAUDE_WRAPPER_PATH`), with args
  `-p "/usage" --output-format json` and a hard timeout (10s). Parses `.result` with two
  regexes (one per line above) extracted into a standalone pure function so it's unit
  testable without spawning anything.
- **Parse failure, non-zero exit, or timeout → all fields `null`, never throws.**
  `UsageGateService` treats `null` as "under threshold" (fail-open — a broken usage check
  must not stop the whole app from trading/researching) and logs a `warn`-level
  `usage_check_failed` event so the failure is visible without blocking anything.
- **`FakeUsageChecker`** (tests): returns scripted snapshots, no subprocess.

### `UsageGateService`

- Holds one in-memory `{ snapshot, checkedAt }`. Re-checks only when the cached entry is
  older than a fixed 60s TTL (an internal constant, not user-configurable — just bounds
  subprocess overhead across multiple schedulers ticking close together).
- `check(): Promise<{ allowed: boolean; reason?: string }>`:
  ```
  allowed = !settings.enabled
         || ( (sessionPct === null || sessionPct < sessionThresholdPct)
           && (weeklyPct  === null || weeklyPct  < weeklyThresholdPct) )
  ```
  `reason` is a human string used for the logged event, e.g. `"session usage 82% >= 80%
  threshold (resets Aug 4 at 3:20am (Australia/Melbourne))"`.

### Settings

New `usageGate` namespace in `settings/store.ts`, same `get`/`set`/`all()` pattern as
`integrations`/`notifications`:

```ts
interface UsageGateSettings {
  enabled: boolean;            // default true
  sessionThresholdPct: number; // default 80
  weeklyThresholdPct: number;  // default 90
}
```

### Wiring (`index.ts`)

Construct near the existing `runner` (`index.ts:84`):

```ts
const usageChecker = new ClaudeCliUsageChecker(CLAUDE_WRAPPER_PATH);
const usageGate = new UsageGateService(settingsStore, usageChecker);
```

Thread `usageGate` into `DecisionService`, `ResearchService`, `MarketScanService` deps, and
into `cli.ts`'s `checkin` command construction (currently builds its own `DecisionService`
independently at `cli.ts:66-71`).

### Call-site checks

At the top of:
- `DecisionService.runCheckinInner` (`decision.ts:95`, before `this.runner.run`)
- `ResearchService.runBriefing` (`research/service.ts:69`, before `this.runner.run`)
- `MarketScanService.runScan` (`market-scan/service.ts:92`, before `this.runner.run`)

```ts
const gate = await this.usageGate.check();
if (!gate.allowed) {
  logEvent(db, 'warn', 'usage_gated', gate.reason!, roundId);
  return;
}
```

Same `usage_gated` event kind across all three call sites for consistent SSE/event-log
handling.

### API

New `GET /api/usage` route (`api/usage-routes.ts`, mirrors `research-routes.ts`) returns the
current cached snapshot + configured thresholds + a computed `sessionGated`/`weeklyGated`
boolean pair. Used by both the settings page (to show live numbers next to the threshold
inputs) and the shell status banner.

### UI

- `SettingsPage.tsx`: new `<Section title="Usage gate">` with a `UsageGateForm` (enabled
  toggle + two number inputs for the thresholds), following the `IntegrationsForm` /
  `useSaveSettings('usageGate')` pattern exactly (`SettingsPage.tsx:294-302` area).
- `AppShell.tsx`: new `UsageGateBanner` component mounted between `<nav>` and `<main>`,
  rendered only when `sessionGated || weeklyGated` is true, e.g. "AI calls paused — weekly
  usage 92% (resets Aug 10, 11am Australia/Melbourne)". Backed by a new `useUsage()` hook in
  `api/hooks.ts` with `refetchInterval` matched to the 60s backend cache TTL.

## Scope decisions (from clarifying questions)

- **Gates all AI call sites** — scheduled check-ins, research, market-scan, AND manual/CLI
  runs. No bypass for manual triggers.
- **Missed occurrences are dropped silently** (a `usage_gated` warn event is logged, nothing
  is queued to fire later) — the next naturally-scheduled tick just runs normally once
  under threshold again, matching how missed cron ticks already coalesce elsewhere in this
  app.
- **60s cache TTL**, not user-configurable.
- **Fail-open** on any usage-check failure (parse error, binary missing, onecli down,
  timeout) — logs `usage_check_failed` but never blocks a run because of it.
- **Two user-configurable thresholds** (session %, weekly %) plus an `enabled` toggle, in a
  new `usageGate` settings namespace, editable on the global Settings page, with a shell-level
  status banner.

## Testing

- **Backend**: `FakeUsageChecker`-based unit tests for `UsageGateService` (threshold math,
  `enabled: false` bypass, null/fail-open handling). Parser unit tests feed real captured
  `.result` strings (the two above, plus malformed/truncated variants) directly into the
  extracted pure parsing function — no subprocess spawned in any test. Integration tests on
  `DecisionService`/`ResearchService`/`MarketScanService` construct each with a gated
  `FakeUsageChecker` and assert `FakeAgentRunner.run` was never called, plus a `usage_gated`
  event row exists. Supertest case for `GET /api/usage`.
- **Frontend**: `useUsage()` hook + `UsageGateBanner` + `UsageGateForm` tested with msw,
  matching the existing settings/hooks test patterns.

## Out of scope

- Parsing/using the reset timestamps for anything beyond display (no scheduled "resume at
  this exact time" logic — polling handles it implicitly).
- Per-round usage thresholds (this is an account-wide subscription limit, so it's a single
  global setting, not per-round config).
- Any change to `agent/runner-options.ts`'s SDK-in-one-file rule — the usage checker spawns
  the *same* already-wrapped `claude` binary the SDK itself spawns, via the same wrapper
  script, for a `--print` one-shot call. This is not a new capability surface, just a second
  caller of an existing, already-authenticated binary path.
