import type { FeeConfig, Market } from './types.js';

/**
 * Paper fee model (spec §3.2): ASX = flat brokerage per trade; US = $0 brokerage
 * but FX bps charged on the AUD notional each way, approximating Stake's FX fee.
 */
export function tradeFeeCents(market: Market, notionalCents: number, fees: FeeConfig): number {
  if (market === 'ASX') return fees.asxFlatCents;
  return Math.ceil((notionalCents * fees.usFxBps) / 10_000);
}

/** Slippage always moves the fill price against the trader. */
export function applySlippage(price: number, side: 'buy' | 'sell', slippageBps: number): number {
  const factor = slippageBps / 10_000;
  return side === 'buy' ? price * (1 + factor) : price * (1 - factor);
}

/** audUsdRate is USD per 1 AUD (Yahoo symbol AUDUSD=X). */
export function usdToAud(usd: number, audUsdRate: number): number {
  return usd / audUsdRate;
}
