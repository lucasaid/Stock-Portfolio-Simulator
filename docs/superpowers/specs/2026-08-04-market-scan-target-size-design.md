# Market-scan target watchlist size — design spec

**Date:** 2026-08-04
**Status:** approved by user, ready for planning

## Problem

Market-scan (`backend/src/market-scan/service.ts`) has no control over how many symbols a
scan should aim to leave on a round's watchlist. Today the only sizing signal is a fixed
`MAX_WATCHLIST = 15` hard cap applied after the fact, plus loose prompt wording ("roughly
3-8 symbols") that only applies in bootstrap mode — the recurring `manage` mode gives the
agent no size guidance at all. TODO.md item: "option for targeted number of watch list
symbols on scan."

## Design

### 1. Config field

`RoundConfig.targetWatchlistSize?: number | null` (default `null`), following the same
surface pattern as `autoWatchlist`/`researchCron`:
- `settings/store.ts` `DEFAULT_SETTINGS.roundDefaults.targetWatchlistSize = null`
- `api/rounds-routes.ts`: added to `CREATE_KEYS` and `PATCHABLE`, validated as either `null`
  or an integer in `[1, 50]` (50 is a generous sanity bound on input, not a target ceiling —
  see §3; it exists only so a typo like `500` can't blow up quote-poll cost)
- Frontend `RoundConfig` mirror type gets the same optional field

Every read site does `config.targetWatchlistSize ?? null`, so a round created before this
feature reads as "no target" and behaves exactly as it does today — no crash, no behavior
change.

### 2. Prompt (`market-scan/prompt.ts`)

`ScanPromptInput` gains `targetSize: number | null`. `buildScanPrompt` branches on it,
independently of `mode`:

- **`null`** → unchanged text: bootstrap says "Choose a small, sensible starting set
  (roughly 3-8 symbols)"; manage mode has no size guidance (today's exact behavior).
- **set to N** →
  - bootstrap: `"Choose around N symbols from the candidates below."` (replaces the
    "roughly 3-8" line)
  - manage: `"Aim for around N symbols in total (you currently hold {held.length} of
    them) — add or drop from the candidates below to get close to that number."`

### 3. Enforcement (`market-scan/service.ts`)

The existing hardcoded cap:
```ts
const withHeld = [...new Set([...heldSymbols, ...inMarket])].slice(0, MAX_WATCHLIST);
```
becomes:
```ts
const cap = config.targetWatchlistSize ?? MAX_WATCHLIST;
const withHeld = [...new Set([...heldSymbols, ...inMarket])].slice(0, cap);
```
`MAX_WATCHLIST` (15) stops being an always-on ceiling and becomes just the fallback default
when no target is set — the user's number is authoritative, per the earlier design
discussion (no additional clamp on top of it beyond the `[1, 50]` input validation in §1).

Because `heldSymbols` is spread first into the deduped array before `.slice(0, cap)` runs,
held positions are never trimmed by the cap — only newly-proposed (non-held) symbols get cut
once the union reaches `cap`. If held count already exceeds the target (e.g. 8 held, target
6), all 8 stay and zero new symbols are added; the target acts as a floor for held positions,
not a hard limit on them. This matches how held positions already bypass the other two
defences (market filter, live-quote check) — they are unconditionally unioned back in before
any filtering runs.

### 4. UI

- `NewRoundPage.tsx` and `ConfigPanel.tsx`: a number input next to the existing "Auto-manage
  watchlist" checkbox, with `<small>` copy: "Leave blank to let the scan choose freely
  (bootstrap picks ~3-8, ongoing scans have no target)." Blank input → `null` on submit,
  matching the existing blank-means-disabled convention used for guardrail fields (never `0`
  — `0` would mean "cap the watchlist at zero symbols", a real, different, almost certainly
  unintended state, so an empty field must serialize to `null`, not `0`).
- `ScansPanel.tsx`: no change — `added`/`removed`/`watchlist_json` already render per scan row
  and need no new fields to reflect a sized-down or sized-up result.

### 5. Testing

- **Backend**:
  - `prompt.ts` unit tests: `targetSize: null` produces today's exact text (regression-pins
    the existing wording); `targetSize: 6` produces the new bootstrap and manage wording,
    including the held-count interpolation in manage mode.
  - `service.ts` unit tests: cap uses `config.targetWatchlistSize` when set and falls back to
    `MAX_WATCHLIST` when `null`; a case with `heldSymbols.length > targetWatchlistSize` where
    all held symbols survive in the final list and zero new symbols are added; a case where
    held + proposed together exceed the target and only proposed symbols are trimmed.
  - `rounds-routes.ts` validation tests: rejects non-integer, `0`, negative, and `> 50`
    values; accepts `null`/omitted and any integer `1..50`.
- **Frontend**: `ConfigPanel.tsx`/`NewRoundPage.tsx` tests asserting blank → field omitted
  from the PATCH/POST body (or sent as `null`), a numeric value → sent as a number.

## Out of scope

- No change to `CANDIDATES_PER_MARKET` (the pool size fed *into* the prompt) — this feature
  only affects how many symbols the scan aims to keep *out of* that pool.
- No per-market target (e.g. "5 ASX + 5 US") — one number for the round's whole watchlist,
  matching how `MAX_WATCHLIST` already worked as a single round-wide cap.
