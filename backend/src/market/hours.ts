import type { Market } from '../engine/types.js';
import { adapterFor } from './adapters.js';

/**
 * Weekday/session check in the exchange's own timezone. Public holidays are
 * intentionally ignored (spec §11: acceptable paper-mode simplification —
 * polls on a holiday just return unchanged prices). Delegates to the market's
 * registered adapter (`market/adapters.ts`) rather than duplicating per-market rules here.
 */
export function isMarketOpen(market: Market, now: Date): boolean {
  return adapterFor(market).isOpen(now);
}
