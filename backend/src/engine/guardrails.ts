export interface BuyClipResult {
  allowedCents: number;
  clipped: boolean;
  rejected: boolean;
  reason: string | null;
}

export function clipBuy(params: {
  requestedCents: number;
  cashCents: number;
  heldCostCents: number;
  startingBalanceCents: number;
  maxPositionPct: number | null;
}): BuyClipResult {
  const { requestedCents, cashCents, heldCostCents, startingBalanceCents, maxPositionPct } = params;
  let allowed = Math.min(requestedCents, cashCents);
  let reason: string | null = allowed < requestedCents ? 'clipped to available cash' : null;

  if (maxPositionPct !== null) {
    const capRoom = Math.floor((startingBalanceCents * maxPositionPct) / 100) - heldCostCents;
    if (capRoom <= 0) {
      return { allowedCents: 0, clipped: false, rejected: true, reason: 'max position size reached' };
    }
    if (allowed > capRoom) {
      allowed = capRoom;
      reason = 'clipped to max position size';
    }
  }

  if (allowed <= 0) {
    return { allowedCents: 0, clipped: false, rejected: true, reason: reason ?? 'insufficient cash' };
  }
  return { allowedCents: allowed, clipped: allowed < requestedCents, rejected: false, reason };
}

export function stopLossTriggered(params: {
  avgCostPrice: number;
  currentPrice: number;
  stopLossPct: number | null;
  stopPrice: number | null;
}): boolean {
  const { avgCostPrice, currentPrice, stopLossPct, stopPrice } = params;
  if (stopPrice !== null && currentPrice <= stopPrice) return true;
  if (stopLossPct !== null && currentPrice <= avgCostPrice * (1 - stopLossPct / 100)) return true;
  return false;
}

export function drawdownBreached(
  equityCents: number,
  startingBalanceCents: number,
  drawdownPausePct: number | null,
): boolean {
  if (drawdownPausePct === null) return false;
  return equityCents < Math.floor((startingBalanceCents * (100 - drawdownPausePct)) / 100);
}
