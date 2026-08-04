import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Market } from './types';

export interface RoundTripStats {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinCents: number;
  avgLossCents: number;
  bestCents: number;
  worstCents: number;
  totalNetCents: number;
  totalFeesCents: number;
  profitFactor: number | null;
  avgHoldMs: number;
  medianHoldMs: number;
  avgReturnPct: number;
}

export interface ReturnBucket {
  fromPct: number;
  toPct: number;
  count: number;
}

export interface ScatterPoint {
  symbol: string;
  holdMs: number;
  returnPct: number;
  netCents: number;
  closedAt: string;
}

export interface RoundTrip {
  symbol: string;
  quantity: number;
  openedAt: string;
  closedAt: string;
  costCents: number;
  proceedsCents: number;
  feesCents: number;
  netCents: number;
  returnPct: number;
  holdMs: number;
}

export interface CostBreakdown {
  totalFeesCents: number;
  /** FX cost is charged inside the fill fee, so fees are split by market, not by fee type. */
  feesByMarket: Partial<Record<Market, number>>;
  byDay: { day: string; feesCents: number }[];
}

export interface CheckinLedgerRow {
  id: number;
  ts: string;
  status: string;
  tokensUsed: number;
  actions: string[];
  reasoning: string[];
}

export interface ConfigEra {
  label: string;
  from: string;
  to: string | null;
  stats: RoundTripStats;
}

export interface AiUsageByType {
  type: 'checkin' | 'research' | 'scan';
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsagePattern {
  /** Ordered tool-name sequence, e.g. ['place_order', 'write_journal']. Empty = no tool calls. */
  sequence: string[];
  count: number;
}

export interface AiUsageBreakdown {
  byType: AiUsageByType[];
  totalTokens: number;
  totalCostUsd: number;
  byDay: { day: string; tokens: number; costUsd: number }[];
  patterns: AiUsagePattern[];
}

export interface RoundAnalytics {
  roundId: number;
  stats: RoundTripStats;
  trips: RoundTrip[];
  histogram: ReturnBucket[];
  scatter: ScatterPoint[];
  costs: CostBreakdown;
  checkins: CheckinLedgerRow[];
  tokenTotals: { checkinTokens: number; checkins: number };
  eras: ConfigEra[];
  aiUsage: AiUsageBreakdown;
}

export interface BenchmarkResult {
  symbol: string;
  points: { ts: string; equityCents: number; benchmarkCents: number | null }[];
  roundReturnPct: number | null;
  benchmarkReturnPct: number | null;
}

export interface DecisionOutcome {
  at: string;
  decision: 'buy' | 'sell' | 'pass';
  symbol: string;
  priceAud: number | null;
  forward: { bars: number; pricePct: number | null }[];
  verdict: string;
}

export interface AnalyticsSummary {
  rounds: {
    id: number;
    name: string;
    status: string;
    stats: RoundTripStats;
    costs: { totalFeesCents: number };
    tokenTotals: { checkinTokens: number; checkins: number };
    aiUsage: { totalTokens: number; totalCostUsd: number };
  }[];
  totals: RoundTripStats;
  aiUsageTotals: { totalTokens: number; totalCostUsd: number; byDay: { day: string; tokens: number; costUsd: number }[] };
}

export interface StopFiring {
  symbol: string;
  at: string;
  stopPrice: number;
  quantity: number;
  proceedsCents: number;
}

export interface ReplayOutcome {
  finalCashCents: number;
  skimmedCents: number;
  feesCents: number;
  stopLossFirings: StopFiring[];
  pausedAt: string | null;
  skippedTrades: number;
  equityCurve: { ts: string; equityCents: number }[];
  insufficientHistory: boolean;
}

export interface ReplaySweepEntry {
  label: string;
  stopLossPct: number | null;
  actual: boolean;
  result: ReplayOutcome;
}

export const analyticsKeys = {
  round: (id: number) => ['analytics', 'round', id] as const,
  benchmark: (id: number, symbol?: string) => ['analytics', 'benchmark', id, symbol ?? 'default'] as const,
  decisions: (id: number) => ['analytics', 'decisions', id] as const,
  summary: ['analytics', 'summary'] as const,
  replaySweep: (id: number) => ['analytics', 'replaySweep', id] as const,
};

export function useRoundAnalytics(id: number): UseQueryResult<RoundAnalytics> {
  return useQuery({
    queryKey: analyticsKeys.round(id),
    queryFn: () => apiFetch<RoundAnalytics>(`/api/analytics/rounds/${id}`),
  });
}

export function useBenchmark(id: number, symbol?: string): UseQueryResult<BenchmarkResult> {
  const query = symbol === undefined ? '' : `?symbol=${encodeURIComponent(symbol)}`;
  return useQuery({
    queryKey: analyticsKeys.benchmark(id, symbol),
    queryFn: () => apiFetch<BenchmarkResult>(`/api/analytics/rounds/${id}/benchmark${query}`),
  });
}

export function useDecisions(id: number): UseQueryResult<DecisionOutcome[]> {
  return useQuery({
    queryKey: analyticsKeys.decisions(id),
    queryFn: () => apiFetch<DecisionOutcome[]>(`/api/analytics/rounds/${id}/decisions`),
  });
}

export function useAnalyticsSummary(): UseQueryResult<AnalyticsSummary> {
  return useQuery({
    queryKey: analyticsKeys.summary,
    queryFn: () => apiFetch<AnalyticsSummary>('/api/analytics/summary'),
  });
}

export function useReplaySweep(id: number): UseQueryResult<ReplaySweepEntry[]> {
  return useQuery({
    queryKey: analyticsKeys.replaySweep(id),
    queryFn: () => apiFetch<ReplaySweepEntry[]>(`/api/replay/rounds/${id}/sweep`),
  });
}
