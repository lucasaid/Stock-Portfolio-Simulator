export type Market = 'ASX' | 'US' | 'CRYPTO';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'custom';
export type TradingStyle = 'day' | 'swing' | 'long';

/** Convert whole dollars to integer cents. All money in this codebase is integer AUD cents. */
export function cents(dollars: number): number {
  return Math.round(dollars * 100);
}

export interface GuardrailConfig {
  /** Sell a position when price falls this % below avg cost. null = disabled. */
  stopLossPct: number | null;
  /** Max % of starting balance held in one symbol (at cost). null = disabled. */
  maxPositionPct: number | null;
  /** Pause the round when equity has lost this % of starting balance. null = disabled. */
  drawdownPausePct: number | null;
  /** Keep firing protective stop-losses while the round is paused (spec §5.1). */
  stopLossWhenPaused: boolean;
}

export interface FeeConfig {
  asxFlatCents: number;
  usFxBps: number;
  cryptoFxBps: number;
  slippageBps: number;
}

export interface RoundConfig {
  name: string;
  startingBalanceCents: number;
  profitGoalCents: number;
  markets: Market[];
  watchlist: string[];
  riskProfile: RiskProfile;
  tradingStyle: TradingStyle;
  guardrails: GuardrailConfig;
  fees: FeeConfig;
  model: string;
  checkinCron: string[];
  /** Cron expressions for the research pass (spec §10 phase 3). Empty disables research. */
  researchCron: string[];
  /** When true, the agent manages its own watchlist via scheduled market scans (TODO.md item 3). */
  autoWatchlist: boolean;
  /** Optional override for the risk-profile prompt block (spec §2.4). */
  riskPrompt?: string;
  /** Optional override for the trading-style prompt block (spec §2.5). */
  stylePrompt?: string;
}

export const DEFAULT_FEES: FeeConfig = { asxFlatCents: 300, usFxBps: 70, cryptoFxBps: 100, slippageBps: 0 };

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  stopLossPct: 10,
  maxPositionPct: 40,
  drawdownPausePct: 50,
  stopLossWhenPaused: true,
};
