import {
  useMutation, useQueries, useQuery, useQueryClient,
  type UseMutationResult, type UseQueryResult,
} from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  BriefingRow, CheckinOutcome, CheckinRow, ChartRange, EquityPoint, EventRow, HistoryResult, JournalRow,
  LedgerRow, Market, MarketCandidate, OptimizerRun, ResearchOutcome, RoundConfig, RoundDetail, RoundListItem, ScanOutcome,
  ScanRow, Settings, SummaryRow, SymbolRow, TradeResult, TradeRow, UsageStatus,
} from './types';

/** Every query key lives here. Never inline a raw key string in a component. */
export const qk = {
  me: ['me'] as const,
  rounds: ['rounds'] as const,
  round: (id: number) => ['round', id] as const,
  equity: (id: number) => ['round', id, 'equity'] as const,
  trades: (id: number) => ['round', id, 'trades'] as const,
  ledger: (id: number) => ['round', id, 'ledger'] as const,
  journal: (id: number) => ['round', id, 'journal'] as const,
  summaries: (id: number) => ['round', id, 'summaries'] as const,
  checkins: (id: number) => ['round', id, 'checkins'] as const,
  briefings: (id: number) => ['round', id, 'briefings'] as const,
  scans: (id: number) => ['round', id, 'scans'] as const,
  events: (roundId?: number) => ['events', roundId ?? 'all'] as const,
  settings: ['settings'] as const,
  usage: ['usage'] as const,
  optimizerRuns: ['optimizer', 'runs'] as const,
  symbols: ['symbols'] as const,
  quotes: (symbols: string[]) => ['quotes', [...symbols].sort().join(',')] as const,
  fx: ['fx'] as const,
  history: (symbol: string, range: ChartRange) => ['history', symbol, range] as const,
  /** Prefix key: invalidating this hits every per-round query at once. */
  allRounds: ['round'] as const,
};

export function useMe(): UseQueryResult<{ username: string }> {
  return useQuery({ queryKey: qk.me, queryFn: () => apiFetch<{ username: string }>('/api/auth/me'), retry: false });
}

export function useLogin(): UseMutationResult<{ ok: true }, Error, { username: string; password: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ ok: true }>('/api/auth/login', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useLogout(): UseMutationResult<{ ok: true }, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    onSuccess: async () => {
      // Drop every cached round/settings payload so a second user on the same
      // browser never sees the first one's data...
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      // ...then force a fresh session check. Clearing alone does not refetch:
      // the mounted observer keeps its last value until something re-runs it.
      await client.refetchQueries({ queryKey: qk.me });
    },
  });
}

export function useChangePassword(): UseMutationResult<{ ok: true }, Error, { current: string; next: string }> {
  return useMutation({ mutationFn: (body) => apiFetch<{ ok: true }>('/api/auth/password', { method: 'POST', body }) });
}

export function useRounds(): UseQueryResult<RoundListItem[]> {
  return useQuery({ queryKey: qk.rounds, queryFn: () => apiFetch<RoundListItem[]>('/api/rounds') });
}

export function useRound(id: number): UseQueryResult<RoundDetail> {
  return useQuery({ queryKey: qk.round(id), queryFn: () => apiFetch<RoundDetail>(`/api/rounds/${id}`) });
}

export function useEquity(id: number): UseQueryResult<EquityPoint[]> {
  return useQuery({ queryKey: qk.equity(id), queryFn: () => apiFetch<EquityPoint[]>(`/api/rounds/${id}/equity`) });
}

/** Most recent mark-to-market equity (cash + held positions), or null with no snapshot yet. */
export function latestEquityCents(points: EquityPoint[]): number | null {
  if (points.length === 0) return null;
  return points.reduce((latest, p) => (Date.parse(p.ts) > Date.parse(latest.ts) ? p : latest)).equity_cents;
}

export function useTrades(id: number): UseQueryResult<TradeRow[]> {
  return useQuery({ queryKey: qk.trades(id), queryFn: () => apiFetch<TradeRow[]>(`/api/rounds/${id}/trades`) });
}

export function useLedger(id: number): UseQueryResult<LedgerRow[]> {
  return useQuery({ queryKey: qk.ledger(id), queryFn: () => apiFetch<LedgerRow[]>(`/api/rounds/${id}/ledger`) });
}

export function useJournal(id: number): UseQueryResult<JournalRow[]> {
  return useQuery({ queryKey: qk.journal(id), queryFn: () => apiFetch<JournalRow[]>(`/api/rounds/${id}/journal`) });
}

export function useSummaries(id: number): UseQueryResult<SummaryRow[]> {
  return useQuery({ queryKey: qk.summaries(id), queryFn: () => apiFetch<SummaryRow[]>(`/api/rounds/${id}/summaries`) });
}

export function useCheckins(id: number): UseQueryResult<CheckinRow[]> {
  return useQuery({ queryKey: qk.checkins(id), queryFn: () => apiFetch<CheckinRow[]>(`/api/rounds/${id}/checkins`) });
}

export function useBriefings(id: number): UseQueryResult<BriefingRow[]> {
  return useQuery({ queryKey: qk.briefings(id), queryFn: () => apiFetch<BriefingRow[]>(`/api/rounds/${id}/briefings`) });
}

export function useRunResearch(id: number): UseMutationResult<ResearchOutcome, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ResearchOutcome>(`/api/rounds/${id}/research`, { method: 'POST' }),
    onSuccess: () => {
      for (const key of [qk.briefings(id), qk.round(id)]) void client.invalidateQueries({ queryKey: key });
    },
  });
}

export function useScans(id: number): UseQueryResult<ScanRow[]> {
  return useQuery({ queryKey: qk.scans(id), queryFn: () => apiFetch<ScanRow[]>(`/api/rounds/${id}/scans`) });
}

export function useRunScan(id: number): UseMutationResult<ScanOutcome, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ScanOutcome>(`/api/rounds/${id}/scan`, { method: 'POST' }),
    onSuccess: () => {
      // A successful scan can change the watchlist, which shows elsewhere on
      // the round detail page — not just here.
      for (const key of [qk.scans(id), qk.round(id)]) void client.invalidateQueries({ queryKey: key });
    },
  });
}

export function useEvents(roundId?: number): UseQueryResult<EventRow[]> {
  const query = roundId === undefined ? '' : `?roundId=${roundId}`;
  return useQuery({ queryKey: qk.events(roundId), queryFn: () => apiFetch<EventRow[]>(`/api/events${query}`) });
}

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: qk.settings, queryFn: () => apiFetch<Settings>('/api/settings') });
}

/** refetchInterval matches the backend's 60s usage-check cache TTL. */
export function useUsage(): UseQueryResult<UsageStatus> {
  return useQuery({
    queryKey: qk.usage,
    queryFn: () => apiFetch<UsageStatus>('/api/usage'),
    refetchInterval: 60_000,
  });
}

export function useOptimizerRuns(): UseQueryResult<OptimizerRun[]> {
  return useQuery({ queryKey: qk.optimizerRuns, queryFn: () => apiFetch<OptimizerRun[]>('/api/optimizer') });
}

export function useRunOptimizer(): UseMutationResult<{ status: string; detail: string }, Error, { webSearch: boolean }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ status: string; detail: string }>('/api/optimizer/run', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.optimizerRuns });
    },
  });
}

export function useSaveSettings<K extends keyof Settings>(
  namespace: K,
): UseMutationResult<{ ok: true }, Error, Settings[K]> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ ok: true }>(`/api/settings/${namespace}`, { method: 'PUT', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.settings }),
  });
}

export function useSymbols(): UseQueryResult<SymbolRow[]> {
  return useQuery({ queryKey: qk.symbols, queryFn: () => apiFetch<SymbolRow[]>('/api/market/symbols') });
}

/**
 * On-demand pool of real, currently-active symbols for the given markets (Yahoo screener,
 * same source market-scan uses) — a mutation, not a query, since it's only ever triggered by
 * an explicit user action (the watchlist "Shuffle" button), never fetched on mount/cached.
 */
export function useMarketCandidates(): UseMutationResult<MarketCandidate[], Error, Market[]> {
  return useMutation({
    mutationFn: (markets) => apiFetch<MarketCandidate[]>(`/api/market/candidates?markets=${markets.join(',')}`),
  });
}

/** AUD/USD rate, so USD holdings can be valued against their AUD cost basis. */
export function useFxRate(): UseQueryResult<{ audUsd: number }> {
  return useQuery({
    queryKey: qk.fx,
    queryFn: () => apiFetch<{ audUsd: number }>('/api/market/fx'),
    refetchInterval: 300_000,
  });
}

export function useHistory(symbol: string, range: ChartRange): UseQueryResult<HistoryResult> {
  return useQuery({
    queryKey: qk.history(symbol, range),
    queryFn: () => apiFetch<HistoryResult>(`/api/market/history?symbol=${encodeURIComponent(symbol)}&range=${range}`),
    enabled: symbol !== '',
  });
}

export function useKillSwitch(): UseMutationResult<{ paused: number }, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ paused: number }>('/api/kill', { method: 'POST' }),
    onSuccess: () => {
      // The kill switch pauses every active round, so any open round detail is
      // stale too — its own kill_switch event carries no round_id to key off.
      void client.invalidateQueries({ queryKey: qk.allRounds });
      void client.invalidateQueries({ queryKey: qk.rounds });
    },
  });
}

export function useRoundStatus(id: number): UseMutationResult<{ status: string }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action) => apiFetch<{ status: string }>(`/api/rounds/${id}/status`, { method: 'POST', body: { action } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.round(id) });
      void client.invalidateQueries({ queryKey: qk.rounds });
    },
  });
}

export function usePatchConfig(id: number): UseMutationResult<{ changed: number }, Error, Partial<RoundConfig>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ changed: number }>(`/api/rounds/${id}/config`, { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.round(id) });
      // A rename (or a goal change) shows on the overview cards too.
      void client.invalidateQueries({ queryKey: qk.rounds });
    },
  });
}

export interface OrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  amountCents?: number;
  quantity?: number | 'all';
}

export function usePlaceOrder(id: number): UseMutationResult<TradeResult, Error, OrderInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<TradeResult>(`/api/rounds/${id}/orders`, { method: 'POST', body }),
    onSuccess: () => {
      for (const key of [qk.round(id), qk.trades(id), qk.ledger(id), qk.equity(id), qk.rounds]) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useRunCheckin(id: number): UseMutationResult<CheckinOutcome, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<CheckinOutcome>(`/api/rounds/${id}/checkin`, { method: 'POST' }),
    onSuccess: () => {
      // A check-in can trade, which moves cash, equity and the overview cards —
      // not just the journal.
      for (const key of [
        qk.round(id), qk.checkins(id), qk.journal(id), qk.trades(id), qk.ledger(id), qk.equity(id), qk.rounds,
      ]) {
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useCreateRound(): UseMutationResult<{ id: number }, Error, Partial<RoundConfig> & { name: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<{ id: number }>('/api/rounds', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.rounds }),
  });
}

/**
 * Trades on one symbol across every round — the Markets page marks them all
 * (spec §6). One query per round keeps the per-round caches shared.
 */
export function useTradesForSymbol(symbol: string): { trades: TradeRow[]; isPending: boolean } {
  const rounds = useRounds();
  const results = useQueries({
    queries: (rounds.data ?? []).map((round) => ({
      queryKey: qk.trades(round.id),
      queryFn: () => apiFetch<TradeRow[]>(`/api/rounds/${round.id}/trades`),
    })),
  });
  const trades = results.flatMap((result) => result.data ?? []).filter((trade) => trade.symbol === symbol);
  return { trades, isPending: rounds.isPending || results.some((r) => r.isPending) };
}

export function useTrackSymbol(): UseMutationResult<{ symbol: string }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (symbol) => apiFetch<{ symbol: string }>('/api/market/symbols', { method: 'POST', body: { symbol } }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.symbols }),
  });
}

export function useArchiveSymbol(): UseMutationResult<
  { symbol: string; archived: boolean },
  Error,
  { symbol: string; archived: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, archived }) =>
      apiFetch<{ symbol: string; archived: boolean }>(`/api/market/symbols/${encodeURIComponent(symbol)}/archive`, {
        method: 'POST',
        body: { archived },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.symbols }),
  });
}
