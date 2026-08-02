import type { Quote } from '../broker/types.js';
import type { DB } from '../db/connection.js';
import type { RoundService } from '../rounds/service.js';

function dollars(centsValue: number): string {
  return `$${(centsValue / 100).toFixed(2)}`;
}

function signedDollars(centsValue: number): string {
  return `${centsValue >= 0 ? '+' : '-'}$${Math.abs(centsValue / 100).toFixed(2)}`;
}

/** Spec §4.2: the compact check-in prompt. Everything the agent may act on, nothing else. */
export function buildSnapshot(
  db: DB,
  rounds: RoundService,
  roundId: number,
  quotes: Map<string, Quote>,
  audUsdRate: number,
): string {
  const round = rounds.get(roundId);
  const config = rounds.config(roundId);
  const pocketed = rounds.totalSkimsCents(roundId);
  const lines: string[] = [];

  lines.push(`# Check-in snapshot — round "${round.name}" (${new Date().toISOString()})`);
  lines.push('');
  lines.push(`Cash: ${dollars(round.cash_cents)} (starting balance ${dollars(round.starting_balance_cents)})`);
  lines.push(`Pocketed so far: ${dollars(pocketed)} of ${dollars(round.profit_goal_cents)} goal`);
  lines.push(
    `Guardrails: stop-loss ${config.guardrails.stopLossPct ?? 'off'}% | max position ${config.guardrails.maxPositionPct ?? 'off'}% | drawdown pause ${config.guardrails.drawdownPausePct ?? 'off'}%`,
  );
  lines.push('');

  lines.push('## Open positions');
  const positions = rounds.openPositions(roundId);
  if (positions.length === 0) lines.push('(none)');
  for (const position of positions) {
    const quote = quotes.get(position.symbol);
    const avgCost = position.cost_basis_cents / 100 / position.quantity;
    if (quote) {
      const priceAud = quote.currency === 'USD' ? quote.price / audUsdRate : quote.price;
      const valueCents = Math.round(position.quantity * priceAud * 100);
      const pl = valueCents - position.cost_basis_cents;
      lines.push(
        `- ${position.symbol}: ${position.quantity} shares, avg cost $${avgCost.toFixed(2)}, now $${priceAud.toFixed(2)}${quote.stale ? ' [STALE]' : ''}, unrealised ${signedDollars(pl)}${position.stop_loss_price !== null ? `, stop @ $${position.stop_loss_price}` : ''}`,
      );
    } else {
      lines.push(`- ${position.symbol}: ${position.quantity} shares, avg cost $${avgCost.toFixed(2)}, no live quote`);
    }
  }
  lines.push('');

  lines.push('## Watchlist quotes');
  for (const symbol of config.watchlist) {
    const quote = quotes.get(symbol);
    if (!quote) {
      lines.push(`- ${symbol}: no quote available`);
      continue;
    }
    const priceAud = quote.currency === 'USD' ? quote.price / audUsdRate : quote.price;
    lines.push(`- ${symbol}: $${priceAud.toFixed(2)} AUD${quote.stale ? ' [STALE — orders will be rejected]' : ''}`);
  }
  lines.push('');

  lines.push('## Recent trades (last 10)');
  const trades = db
    .prepare('SELECT side, quantity, symbol, price_aud, executed_at FROM trades WHERE round_id = ? ORDER BY id DESC LIMIT 10')
    .all(roundId) as { side: string; quantity: number; symbol: string; price_aud: number; executed_at: string }[];
  if (trades.length === 0) lines.push('(none)');
  for (const trade of trades) {
    lines.push(`- ${trade.executed_at}: ${trade.side} ${trade.quantity} ${trade.symbol} @ $${trade.price_aud.toFixed(2)}`);
  }
  lines.push('');

  lines.push('## Events since last check-in');
  const lastCheckin = db
    .prepare("SELECT ts FROM checkins WHERE round_id = ? AND status != 'running' ORDER BY id DESC LIMIT 1")
    .get(roundId) as { ts: string } | undefined;
  const since = lastCheckin?.ts ?? '1970-01-01T00:00:00.000Z';
  const events = db
    .prepare('SELECT kind, message, created_at FROM event_log WHERE round_id = ? AND created_at > ? ORDER BY id DESC LIMIT 20')
    .all(roundId, since) as { kind: string; message: string; created_at: string }[];
  if (events.length === 0) lines.push('(none)');
  for (const event of events) lines.push(`- [${event.kind}] ${event.message}`);
  lines.push('');

  lines.push('## Your recent history');
  const summaries = db
    .prepare("SELECT day, narrative FROM daily_summaries WHERE round_id = ? AND day != 'abstract' ORDER BY day DESC LIMIT 7")
    .all(roundId) as { day: string; narrative: string | null }[];
  const abstract = db
    .prepare("SELECT narrative FROM daily_summaries WHERE round_id = ? AND day = 'abstract'")
    .get(roundId) as { narrative: string | null } | undefined;
  if (abstract?.narrative) lines.push(`Long-term summary: ${abstract.narrative}`);
  for (const summary of summaries.reverse()) {
    if (summary.narrative) lines.push(`- ${summary.day}: ${summary.narrative}`);
  }
  const lastJournal = db
    .prepare("SELECT note FROM journal_entries WHERE round_id = ? AND author = 'agent' ORDER BY id DESC LIMIT 1")
    .get(roundId) as { note: string } | undefined;
  if (lastJournal) lines.push(`Last journal note: ${lastJournal.note}`);
  if (!abstract && summaries.length === 0 && !lastJournal) lines.push('(no history yet — this is an early check-in)');
  lines.push('');

  lines.push('Research briefing: none (research mode not yet enabled).');
  lines.push('');
  lines.push('Decide your actions now using the tools, then journal.');
  return lines.join('\n');
}
