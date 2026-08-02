/**
 * Pure analytics. No I/O, no database — every function here takes plain data.
 * Money is integer AUD cents throughout; percentages and ratios are floats.
 */

export interface AnalyticsTrade {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  grossCents: number;
  feeCents: number;
  executedAt: string;
}

export interface RoundTrip {
  symbol: string;
  quantity: number;
  buyTradeId: number;
  sellTradeId: number;
  openedAt: string;
  closedAt: string;
  costCents: number;
  proceedsCents: number;
  feesCents: number;
  /** proceeds − cost − fees. */
  netCents: number;
  /** Net return against the matched cost. */
  returnPct: number;
  holdMs: number;
}

interface OpenLot {
  tradeId: number;
  symbol: string;
  remaining: number;
  originalQty: number;
  grossCents: number;
  feeCents: number;
  /** Cost and fee cents not yet allocated to a round trip. */
  costLeftCents: number;
  feeLeftCents: number;
  executedAt: string;
}

/** Share quantities are floats; anything under this is "nothing left". */
const QTY_EPSILON = 1e-9;

/**
 * FIFO lot matching. A sell consumes the oldest open lots for its symbol; fees
 * on both sides are allocated in proportion to the matched quantity. Sells with
 * no open lot are skipped rather than fabricated — the round service guarantees
 * they cannot happen, and inventing a zero-cost lot would report a fake win.
 *
 * Cost allocation tracks the remainder rather than rounding each slice
 * independently: three 1/3 slices of a 1000c lot must total 1000c, not 999c.
 * The final slice of a lot takes whatever cents are left.
 */
export function matchRoundTrips(trades: AnalyticsTrade[]): RoundTrip[] {
  const ordered = [...trades].sort(
    (a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt) || a.id - b.id,
  );
  const open = new Map<string, OpenLot[]>();
  const trips: RoundTrip[] = [];

  for (const trade of ordered) {
    if (trade.side === 'buy') {
      const lots = open.get(trade.symbol) ?? [];
      lots.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        remaining: trade.quantity,
        originalQty: trade.quantity,
        grossCents: trade.grossCents,
        feeCents: trade.feeCents,
        costLeftCents: trade.grossCents,
        feeLeftCents: trade.feeCents,
        executedAt: trade.executedAt,
      });
      open.set(trade.symbol, lots);
      continue;
    }

    let unmatched = trade.quantity;
    let sellProceedsLeft = trade.grossCents;
    let sellFeeLeft = trade.feeCents;
    const lots = open.get(trade.symbol) ?? [];

    while (unmatched > QTY_EPSILON && lots.length > 0) {
      const lot = lots[0]!;
      const matched = Math.min(unmatched, lot.remaining);
      const closesLot = lot.remaining - matched <= QTY_EPSILON;
      const closesSell = unmatched - matched <= QTY_EPSILON;

      // The last slice takes the remainder so the parts always sum to the whole.
      const costCents = closesLot ? lot.costLeftCents : Math.round(lot.grossCents * (matched / lot.originalQty));
      const buyFeeCents = closesLot ? lot.feeLeftCents : Math.round(lot.feeCents * (matched / lot.originalQty));
      const proceedsCents = closesSell ? sellProceedsLeft : Math.round(trade.grossCents * (matched / trade.quantity));
      const sellFeeCents = closesSell ? sellFeeLeft : Math.round(trade.feeCents * (matched / trade.quantity));

      const feesCents = buyFeeCents + sellFeeCents;
      const netCents = proceedsCents - costCents - feesCents;

      trips.push({
        symbol: trade.symbol,
        quantity: matched,
        buyTradeId: lot.tradeId,
        sellTradeId: trade.id,
        openedAt: lot.executedAt,
        closedAt: trade.executedAt,
        costCents,
        proceedsCents,
        feesCents,
        netCents,
        returnPct: costCents === 0 ? 0 : (netCents / costCents) * 100,
        holdMs: Date.parse(trade.executedAt) - Date.parse(lot.executedAt),
      });

      lot.remaining -= matched;
      lot.costLeftCents -= costCents;
      lot.feeLeftCents -= buyFeeCents;
      unmatched -= matched;
      sellProceedsLeft -= proceedsCents;
      sellFeeLeft -= sellFeeCents;
      if (lot.remaining <= QTY_EPSILON) lots.shift();
    }

    open.set(trade.symbol, lots);
  }

  return trips;
}

export interface RoundTripStats {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinCents: number;
  /** Negative, or 0 when there were no losses. */
  avgLossCents: number;
  bestCents: number;
  worstCents: number;
  totalNetCents: number;
  totalFeesCents: number;
  /** Gross wins ÷ gross losses. Null when there are no losses to divide by. */
  profitFactor: number | null;
  avgHoldMs: number;
  medianHoldMs: number;
  avgReturnPct: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function summarizeRoundTrips(trips: RoundTrip[]): RoundTripStats {
  // A scratch (netCents === 0) is neither a win nor a loss — counting it either
  // way would flatter or punish the win rate for a trade that did nothing.
  const wins = trips.filter((t) => t.netCents > 0);
  const losses = trips.filter((t) => t.netCents < 0);
  const grossWin = wins.reduce((sum, t) => sum + t.netCents, 0);
  const grossLoss = losses.reduce((sum, t) => sum + Math.abs(t.netCents), 0);

  return {
    closed: trips.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trips.length === 0 ? 0 : (wins.length / trips.length) * 100,
    avgWinCents: wins.length === 0 ? 0 : Math.round(grossWin / wins.length),
    avgLossCents: losses.length === 0 ? 0 : -Math.round(grossLoss / losses.length),
    bestCents: trips.length === 0 ? 0 : Math.max(...trips.map((t) => t.netCents)),
    worstCents: trips.length === 0 ? 0 : Math.min(...trips.map((t) => t.netCents)),
    totalNetCents: trips.reduce((sum, t) => sum + t.netCents, 0),
    totalFeesCents: trips.reduce((sum, t) => sum + t.feesCents, 0),
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    avgHoldMs: Math.round(mean(trips.map((t) => t.holdMs))),
    medianHoldMs: Math.round(median(trips.map((t) => t.holdMs))),
    avgReturnPct: mean(trips.map((t) => t.returnPct)),
  };
}

export interface ReturnBucket {
  fromPct: number;
  toPct: number;
  count: number;
}

/**
 * Buckets percentage returns into fixed-width bins aligned on zero, so wins and
 * losses stay visually symmetric. A value exactly on a boundary lands in the
 * upper bucket.
 */
export function bucketReturns(returnsPct: number[], widthPct = 5): ReturnBucket[] {
  if (returnsPct.length === 0) return [];
  const lowest = Math.floor(Math.min(...returnsPct) / widthPct) * widthPct;
  const highest = Math.floor(Math.max(...returnsPct) / widthPct) * widthPct + widthPct;

  const buckets: ReturnBucket[] = [];
  for (let from = lowest; from < highest; from += widthPct) {
    buckets.push({ fromPct: from, toPct: from + widthPct, count: 0 });
  }
  for (const value of returnsPct) {
    const index = Math.min(buckets.length - 1, Math.floor((value - lowest) / widthPct));
    buckets[index]!.count += 1;
  }
  return buckets;
}
