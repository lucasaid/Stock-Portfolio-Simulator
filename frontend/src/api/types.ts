export type Market = 'ASX' | 'US' | 'CRYPTO';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'custom';
export type TradingStyle = 'day' | 'swing' | 'long';
export type RoundStatus = 'active' | 'paused' | 'takeover' | 'goal_reached' | 'busted' | 'archived';
export type Actor = 'agent' | 'operator' | 'stop_loss';

export interface GuardrailConfig {
  stopLossPct: number | null;
  maxPositionPct: number | null;
  drawdownPausePct: number | null;
  stopLossWhenPaused: boolean;
}

export interface FeeConfig {
  asxFlatCents: number;
  usFxBps: number;
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
  researchCron: string[];
  autoWatchlist: boolean;
  riskPrompt?: string;
  stylePrompt?: string;
}

export interface RoundListItem {
  id: number;
  name: string;
  status: RoundStatus;
  starting_balance_cents: number;
  cash_cents: number;
  profit_goal_cents: number;
  totalSkimsCents: number;
}

export interface RoundRow extends RoundListItem {
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface PositionRow {
  id: number;
  round_id: number;
  symbol: string;
  market: Market;
  quantity: number;
  cost_basis_cents: number;
  stop_loss_price: number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface RoundDetail {
  round: RoundRow;
  config: RoundConfig;
  positions: PositionRow[];
  totalSkimsCents: number;
}

export interface EquityPoint {
  id: number;
  round_id: number;
  ts: string;
  cash_cents: number;
  holdings_cents: number;
  equity_cents: number;
}

export interface TradeRow {
  id: number;
  order_id: number;
  round_id: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price_aud: number;
  gross_cents: number;
  fee_cents: number;
  executed_at: string;
}

export interface LedgerRow {
  id: number;
  round_id: number;
  type: 'deposit' | 'buy' | 'sell' | 'fee' | 'skim';
  amount_cents: number;
  balance_after_cents: number;
  ref_order_id: number | null;
  note: string | null;
  created_at: string;
}

export interface CheckinRow {
  id: number;
  ts: string;
  status: string;
  tokens_used: number | null;
  actions_json: string;
}

export interface JournalRow {
  id: number;
  checkin_id: number | null;
  author: string;
  note: string;
  created_at: string;
}

export interface SummaryRow {
  day: string;
  digest_json: string;
  narrative: string | null;
  created_at: string;
}

export interface DailyDigest {
  trades: number;
  skimsCents: number;
  feesCents: number;
  tokensUsed: number;
  events: string[];
  journals: string[];
}

export interface BriefingRow {
  id: number;
  created_at: string;
  briefing: string;
  status: string;
  tokens_used: number;
  cost_usd: number;
}

export interface ResearchOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface ScanRow {
  id: number;
  created_at: string;
  status: string;
  watchlist_json: string | null;
  added_json: string;
  removed_json: string;
  detail: string;
  tokens_used: number;
  cost_usd: number;
}

export interface ScanOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface UsageSnapshot {
  sessionPct: number | null;
  sessionResetsAt: string | null;
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
}

export interface UsageStatus {
  snapshot: UsageSnapshot;
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
  sessionGated: boolean;
  weeklyGated: boolean;
}

export interface EventRow {
  id: number;
  round_id: number | null;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  created_at: string;
}

export interface Quote {
  symbol: string;
  market: Market;
  price: number;
  currency: 'AUD' | 'USD';
  ts: string;
  stale: boolean;
}

export type ChartRange = '1D' | '1W' | '1M' | '3M' | 'ALL';

export interface OhlcBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface HistoryResult {
  symbol: string;
  range: ChartRange;
  interval: string;
  currency: string;
  bars: OhlcBar[];
  stale: boolean;
}

export interface SymbolRow {
  symbol: string;
  market: Market;
  name: string | null;
  archived: number;
  first_seen_at: string | null;
  last_polled_at: string | null;
}

export interface MarketCandidate {
  symbol: string;
  name?: string;
  changePct?: number;
}

export interface NtfySettings {
  url: string;
  topic: string;
  enabled: boolean;
}

export interface IntegrationSettings {
  ntfy: NtfySettings;
  pollIntervalMinutes: number;
  /** Index ETF the analytics benchmark compares each round against (spec §6). */
  benchmarkSymbol: string;
}

export interface LookAndFeelSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  chartStyle: 'line' | 'candles';
  timezone: string;
}

export interface UsageGateSettings {
  enabled: boolean;
  sessionThresholdPct: number;
  weeklyThresholdPct: number;
}

export interface Settings {
  roundDefaults: Omit<RoundConfig, 'name'>;
  integrations: IntegrationSettings;
  lookAndFeel: LookAndFeelSettings;
  notifications: Record<string, boolean>;
  usageGate: UsageGateSettings;
}

export interface TradeResult {
  status: 'filled' | 'rejected';
  reason: string | null;
  skimCents: number;
}

export interface CheckinOutcome {
  status: string;
  [key: string]: unknown;
}
