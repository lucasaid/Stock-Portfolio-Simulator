import type { FeeConfig, Market } from '../engine/types.js';

export interface Quote {
  symbol: string;
  market: Market;
  price: number;
  currency: 'AUD' | 'USD';
  ts: string;
  stale: boolean;
}

export interface OrderRequest {
  roundId: number;
  clientOrderId: string;
  symbol: string;
  market: Market;
  side: 'buy' | 'sell';
  /** Buys: AUD cents to spend (fees come out of this). */
  amountCents?: number;
  /** Sells: share quantity to sell. */
  quantity?: number;
  placedBy: 'agent' | 'operator' | 'stop_loss';
}

export interface Fill {
  orderId: number;
  quantity: number;
  priceAud: number;
  grossCents: number;
  feeCents: number;
  /** Signed cash movement: negative for buys, positive for sells. */
  netCashDeltaCents: number;
}

export interface Broker {
  execute(req: OrderRequest, quote: Quote, audUsdRate: number, fees: FeeConfig): Fill;
}
