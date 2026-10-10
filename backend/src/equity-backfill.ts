import type { DB } from './db/connection.js';
import { logEvent } from './db/events.js';
import type { BarFetcher, OhlcBar } from './market/history.js';
import type { RoundService } from './rounds/service.js';

export interface EquityBackfillDeps {
  db: DB;
  rounds: RoundService;
  fetchBars: BarFetcher;
}

/** Gaps shorter than this are normal polling cadence (or an overnight close), not downtime. */
const MIN_GAP_MS = 60 * 60_000;
/** Up to a week of downtime is filled hourly; anything longer daily, so a long outage can't
 *  flood the equity endpoint's 2000-row window and push older history out of the chart. */
const HOURLY_MAX_GAP_MS = 7 * 86_400_000;

/** Close of the last bar at or before `ts` (bars ascending), or undefined if none yet. */
function closeAt(bars: OhlcBar[], ts: string): number | undefined {
  let close: number | undefined;
  for (const bar of bars) {
    if (bar.ts > ts) break;
    close = bar.close;
  }
  return close;
}

/**
 * Fill the equity chart across a period the app wasn't running. For each live round, takes
 * the last recorded snapshot and marks its open positions to market against historical bars
 * from then until `now`, so a restart after downtime doesn't draw one straight jump.
 *
 * `now` is the end of the gap: at boot it's literally now; passing an earlier time fills a gap
 * that later snapshots have already closed (e.g. a one-off repair of old downtime).
 *
 * Purely a chart backfill: it never trades, and never retroactively fires stop-losses that
 * would have triggered during the gap. Never throws — a failed round logs and is skipped.
 */
export async function backfillEquity(deps: EquityBackfillDeps, now = new Date()): Promise<number> {
  const { db } = deps;
  const ids = db
    .prepare(`SELECT id FROM rounds WHERE status IN ('active', 'paused', 'takeover')`)
    .all() as { id: number }[];
  let inserted = 0;
  for (const { id } of ids) {
    try {
      inserted += await backfillRound(deps, id, now);
    } catch (err) {
      logEvent(db, 'warn', 'equity_backfill_failed', `round ${id}: ${(err as Error).message}`, id);
    }
  }
  if (inserted > 0) logEvent(db, 'info', 'equity_backfilled', `backfilled ${inserted} equity snapshot(s) after downtime`);
  return inserted;
}

async function backfillRound({ db, rounds, fetchBars }: EquityBackfillDeps, roundId: number, now: Date): Promise<number> {
  const last = db
    .prepare('SELECT ts, cash_cents FROM equity_snapshots WHERE round_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
    .get(roundId, now.toISOString()) as { ts: string; cash_cents: number } | undefined;
  if (!last) return 0;
  const gapMs = now.getTime() - Date.parse(last.ts);
  if (gapMs < MIN_GAP_MS) return 0;

  // Nothing trades while the server is down — except the standalone `cli checkin`. If that
  // happened, holdings during the gap are unknown, so skip rather than chart a guess.
  const tradedSince = db
    .prepare('SELECT 1 FROM trades WHERE round_id = ? AND executed_at > ? AND executed_at < ? LIMIT 1')
    .get(roundId, last.ts, now.toISOString());
  if (tradedSince) return 0;

  // An all-cash round's equity is flat across the gap; the chart already draws that.
  const positions = rounds.openPositions(roundId);
  if (positions.length === 0) return 0;

  const interval = gapMs <= HOURLY_MAX_GAP_MS ? '1h' : '1d';
  const period1 = new Date(last.ts);
  const series = new Map<string, { currency: string; bars: OhlcBar[] }>();
  for (const pos of positions) {
    const fetched = await fetchBars(pos.symbol, { interval, period1 });
    series.set(pos.symbol, { currency: fetched.currency, bars: [...fetched.bars].sort((a, b) => a.ts.localeCompare(b.ts)) });
  }
  const needsFx = [...series.values()].some((s) => s.currency === 'USD');
  const fx = needsFx ? (await fetchBars('AUDUSD=X', { interval, period1 })).bars.sort((a, b) => a.ts.localeCompare(b.ts)) : [];

  const nowIso = now.toISOString();
  const timestamps = [...new Set([...series.values()].flatMap((s) => s.bars.map((b) => b.ts)))]
    .filter((ts) => ts > last.ts && ts < nowIso)
    .sort();

  const insert = db.prepare(
    'INSERT INTO equity_snapshots (round_id, ts, cash_cents, holdings_cents, equity_cents) VALUES (?, ?, ?, ?, ?)',
  );
  let inserted = 0;
  db.transaction(() => {
    for (const ts of timestamps) {
      let holdings = 0;
      let complete = true;
      for (const pos of positions) {
        const { currency, bars } = series.get(pos.symbol)!;
        let price = closeAt(bars, ts);
        if (price !== undefined && currency === 'USD') {
          const audUsd = closeAt(fx, ts);
          price = audUsd === undefined ? undefined : price / audUsd;
        }
        if (price === undefined) {
          complete = false;
          break;
        }
        holdings += Math.round(pos.quantity * price * 100);
      }
      // Skip a point until every holding has a price — a half-valued point would dip falsely.
      if (!complete) continue;
      insert.run(roundId, ts, last.cash_cents, holdings, last.cash_cents + holdings);
      inserted++;
    }
  })();
  return inserted;
}
