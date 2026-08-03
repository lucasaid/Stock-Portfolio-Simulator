import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import { zonedDayRangeUtc } from '../lib/timezone.js';
import type { RoundService } from '../rounds/service.js';
import type { AgentRunner } from './types.js';

export interface SummaryDeps {
  db: DB;
  rounds: RoundService;
}

export interface DailyDigest {
  trades: number;
  skimsCents: number;
  feesCents: number;
  tokensUsed: number;
  events: string[];
  journals: string[];
}

const SUMMARY_MODEL_MAX_TURNS = 1;

/**
 * The product's day is the Sydney day (spec §6.1). Bucketing by UTC instead put a
 * US overnight session on the day-label BEFORE the one the operator lived through.
 */
export const SUMMARY_TIMEZONE = 'Australia/Sydney';

/** Deterministic digest of one round-day (no tokens). Day = Sydney calendar date. */
export function buildDailyDigest(db: DB, roundId: number, day: string, timeZone = SUMMARY_TIMEZONE): DailyDigest {
  // Half-open [from, to): consecutive days must not overlap or double-count.
  const range = zonedDayRangeUtc(day, timeZone);
  const trades = (db.prepare('SELECT COUNT(*) AS c FROM trades WHERE round_id = ? AND executed_at >= ? AND executed_at < ?')
    .get(roundId, ...range) as { c: number }).c;
  const skims = (db.prepare("SELECT COALESCE(SUM(-amount_cents),0) AS s FROM ledger_entries WHERE round_id = ? AND type = 'skim' AND created_at >= ? AND created_at < ?")
    .get(roundId, ...range) as { s: number }).s;
  const fees = (db.prepare("SELECT COALESCE(SUM(-amount_cents),0) AS s FROM ledger_entries WHERE round_id = ? AND type = 'fee' AND created_at >= ? AND created_at < ?")
    .get(roundId, ...range) as { s: number }).s;
  const tokens = (db.prepare('SELECT COALESCE(SUM(tokens_used),0) AS s FROM checkins WHERE round_id = ? AND ts >= ? AND ts < ?')
    .get(roundId, ...range) as { s: number }).s;
  const events = (db.prepare('SELECT kind, message FROM event_log WHERE round_id = ? AND created_at >= ? AND created_at < ? ORDER BY id')
    .all(roundId, ...range) as { kind: string; message: string }[]).map((e) => `[${e.kind}] ${e.message}`);
  const journals = (db.prepare("SELECT note FROM journal_entries WHERE round_id = ? AND author = 'agent' AND created_at >= ? AND created_at < ? ORDER BY id")
    .all(roundId, ...range) as { note: string }[]).map((j) => j.note);
  return { trades, skimsCents: skims, feesCents: fees, tokensUsed: tokens, events, journals };
}

function digestFallbackNarrative(digest: DailyDigest): string {
  return `${digest.trades} trade(s), $${(digest.skimsCents / 100).toFixed(2)} pocketed, $${(digest.feesCents / 100).toFixed(2)} fees.`;
}

/** Spec §4.3: one summary row per active round-day; narrative via one small runner call. */
export async function runDailySummaries(deps: SummaryDeps, runner: AgentRunner, day: string): Promise<void> {
  const { db } = deps;
  // Activity = trades or check-ins that day. Deliberately NOT event_log —
  // round_created/config events alone don't warrant a daily narrative.
  const roundIds = (db.prepare(
    `SELECT DISTINCT round_id AS id FROM (
       SELECT round_id, executed_at AS at FROM trades
       UNION ALL SELECT round_id, ts FROM checkins
     ) WHERE at >= ? AND at < ?`,
  ).all(...zonedDayRangeUtc(day, SUMMARY_TIMEZONE)) as { id: number }[]).map((r) => r.id);

  for (const roundId of roundIds) {
    const existing = db.prepare('SELECT 1 FROM daily_summaries WHERE round_id = ? AND day = ?').get(roundId, day);
    if (existing) continue;
    const digest = buildDailyDigest(db, roundId, day);
    let narrative = digestFallbackNarrative(digest);
    // Summary/compression calls happen outside any check-in row, so their spend
    // would otherwise be invisible to per-round token analytics (spec §6).
    let narrativeTokens = 0;
    let narrativeCostUsd = 0;
    try {
      const result = await runner.run({
        model: deps.rounds.config(roundId).model,
        systemPrompt:
          'You summarize one day of a paper-trading agent. Write 1-3 sentences: what was done, why (from the journals), and what to watch tomorrow. First person, past tense, no preamble.',
        prompt: `Digest — trades: ${digest.trades}, pocketed: $${(digest.skimsCents / 100).toFixed(2)}, fees: $${(digest.feesCents / 100).toFixed(2)}.\nEvents:\n${digest.events.join('\n') || '(none)'}\nJournals:\n${digest.journals.join('\n') || '(none)'}`,
        tools: [],
        maxTurns: SUMMARY_MODEL_MAX_TURNS,
      });
      narrativeTokens = result.inputTokens + result.outputTokens;
      narrativeCostUsd = result.costUsd;
      if (result.status === 'success' && result.text.trim() !== '') narrative = result.text.trim();
    } catch {
      // fall back to the deterministic narrative; never block the job
    }
    db.prepare('INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(roundId, day, JSON.stringify({ ...digest, narrativeTokens, narrativeCostUsd }), narrative, new Date().toISOString());
    logEvent(
      db,
      'info',
      'daily_summary',
      `round ${roundId} daily summary written for ${day} (narrative: ${narrativeTokens} tokens)`,
      roundId,
    );

    await maybeCompressHistory(deps, runner, roundId);
  }
}

/**
 * Regenerate the round-lifetime abstract when more than 7 dated summaries exist (spec §4.3).
 * Folds incrementally: only days that have newly aged out since the last compression are
 * added to the prior abstract, so the prompt stays roughly constant-sized over time instead
 * of re-summarizing the round's entire history on every run.
 */
async function maybeCompressHistory(deps: SummaryDeps, runner: AgentRunner, roundId: number): Promise<void> {
  const { db } = deps;
  const abstractRow = db.prepare(
    "SELECT narrative, digest_json FROM daily_summaries WHERE round_id = ? AND day = 'abstract'",
  ).get(roundId) as { narrative: string | null; digest_json: string } | undefined;
  const priorAbstract = abstractRow?.narrative ?? '';
  const compressedThrough = abstractRow ? (JSON.parse(abstractRow.digest_json) as { compressedThrough?: string }).compressedThrough : undefined;

  const older = db.prepare(
    "SELECT day, narrative FROM daily_summaries WHERE round_id = ? AND day != 'abstract' ORDER BY day DESC LIMIT -1 OFFSET 7",
  ).all(roundId) as { day: string; narrative: string | null }[];
  const newRows = compressedThrough ? older.filter((r) => r.day > compressedThrough) : older;
  if (newRows.length === 0) return; // nothing newly aged out — skip the model call entirely

  let abstractText = [priorAbstract, ...newRows.map((r) => `${r.day}: ${r.narrative ?? ''}`)].filter(Boolean).join('\n');
  let compressionTokens = 0;
  let compressionCostUsd = 0;
  try {
    const result = await runner.run({
      model: deps.rounds.config(roundId).model,
      systemPrompt:
        'Compress this trading history into a short abstract (max 5 sentences) preserving strategy lessons, notable wins/losses, and standing intentions.',
      prompt: `Existing summary:\n${priorAbstract || '(none yet)'}\n\nNewly aged-out days:\n${newRows.map((r) => `${r.day}: ${r.narrative ?? ''}`).join('\n')}`,
      tools: [],
      maxTurns: SUMMARY_MODEL_MAX_TURNS,
    });
    compressionTokens = result.inputTokens + result.outputTokens;
    compressionCostUsd = result.costUsd;
    if (result.status === 'success' && result.text.trim() !== '') abstractText = result.text.trim();
  } catch {
    // keep the concatenated fallback
  }
  const newestFoldedDay = newRows.reduce((max, r) => (r.day > max ? r.day : max), newRows[0]!.day);
  db.prepare(
    `INSERT INTO daily_summaries (round_id, day, digest_json, narrative, created_at) VALUES (?, 'abstract', ?, ?, ?)
     ON CONFLICT(round_id, day) DO UPDATE SET digest_json = excluded.digest_json, narrative = excluded.narrative, created_at = excluded.created_at`,
  ).run(
    roundId,
    JSON.stringify({ compressedThrough: newestFoldedDay, compressionTokens, compressionCostUsd }),
    abstractText,
    new Date().toISOString(),
  );
}
