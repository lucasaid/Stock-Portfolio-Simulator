import type { Express } from 'express';
import request from 'supertest';
import { AnalyticsService } from '../src/analytics/service.js';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/api/app.js';
import { DecisionService } from '../src/agent/decision.js';
import { AuthService } from '../src/auth/service.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { MarketHistoryService, type BarFetcher } from '../src/market/history.js';
import { SymbolRegistry } from '../src/market/symbols.js';
import type { CandidateFetcher } from '../src/market/candidates.js';
import { MarketScanService } from '../src/market-scan/service.js';
import { OptimizerService } from '../src/optimizer/service.js';
import { ReplayService } from '../src/replay/service.js';
import { ResearchService } from '../src/research/service.js';
import { RoundService } from '../src/rounds/service.js';
import { SettingsStore } from '../src/settings/store.js';
import { UsageGateService } from '../src/agent/usage-gate.js';
import { FakeAgentRunner } from './agent-helper.js';
import { FakeUsageChecker } from './usage-helper.js';

export interface TestCtx {
  app: Express;
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
  analytics: AnalyticsService;
  replay: ReplayService;
  research: ResearchService;
  marketScan: MarketScanService;
  optimizer: OptimizerService;
  usageGate: UsageGateService;
  history: MarketHistoryService;
  symbols: SymbolRegistry;
  /** Flip `fail` to make the bar fetcher throw, exercising the outage path. */
  barFetcher: { fail: boolean };
  prices: Record<string, { price: number; currency: string }>;
}

export function createTestApp(opts: { cookieSecure?: boolean } = {}): TestCtx {
  const db = openDb(':memory:');
  migrate(db);
  const prices: Record<string, { price: number; currency: string }> = {
    'AAPL': { price: 10, currency: 'USD' },
    'AUDUSD=X': { price: 1, currency: 'USD' },
  };
  const fetcher: QuoteFetcher = async (symbols) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };
  const auth = new AuthService(db);
  const settings = new SettingsStore(db);
  // Default fake checker returns an all-null snapshot, which fails open — existing tests'
  // check-in/research/scan behaviour is unaffected unless a test explicitly overrides it.
  const usageGate = new UsageGateService({ db, settings }, new FakeUsageChecker());
  const rounds = new RoundService(db, new PaperBroker(db));
  const market = new MarketDataService(db, fetcher);
  // Separate fakes: the real SdkAgentRunner is shared in index.ts because the model
  // itself only calls tools that were actually offered, but FakeAgentRunner blindly
  // replays a fixed script against whatever `request.tools` it is given, so a
  // check-in script (which names trading tools) would throw if replayed against a
  // research run (which offers none).
  const research = new ResearchService({ db, rounds }, new FakeAgentRunner([], 'Nothing material.'));
  const decision = new DecisionService(
    { db, rounds, market, research },
    new FakeAgentRunner([{ tool: 'write_journal', args: { note: 'checked in' } }], 'All quiet.'),
  );
  // Bars are generated relative to now so the service's lookback window always
  // contains them, whatever the clock says when the suite runs.
  const barFetcher = { fail: false };
  const bars: BarFetcher = async () => {
    if (barFetcher.fail) throw new Error('bar fetch failed');
    const today = Date.now();
    return {
      currency: 'USD',
      bars: [
        { ts: new Date(today - 86_400_000).toISOString(), open: 9, high: 11, low: 8, close: 10, volume: 1000 },
        { ts: new Date(today).toISOString(), open: 10, high: 12, low: 9, close: 11, volume: 1200 },
      ],
    };
  };
  const history = new MarketHistoryService(db, bars);
  const symbols = new SymbolRegistry(db);
  const analytics = new AnalyticsService(db, rounds, history);
  const replay = new ReplayService(db, rounds, history);
  // Separate fake runner from research/decision (same reasoning as above) plus a fake
  // candidate fetcher — the scan must never make a real network call in tests, and the
  // one symbol it proposes (AAPL) must resolve via the fake quote fetcher above so it
  // survives the live-quote validation defence without touching the network.
  const scanCandidates: CandidateFetcher = async () => [{ symbol: 'AAPL' }];
  const marketScan = new MarketScanService(
    { db, rounds, market },
    new FakeAgentRunner([], '{"watchlist": ["AAPL"]}'),
    scanCandidates,
  );

  // Separate fake runner from research/decision/marketScan (same reasoning as those) —
  // the optimizer offers no tools at all, so a scripted tool-call fake would throw if reused.
  const optimizer = new OptimizerService(
    { db, settings },
    new FakeAgentRunner([], '## Findings\nNothing notable.\n## Implementation prompt\nn/a'),
  );

  const app = buildApp({
    db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan,
    usageGate, candidates: scanCandidates, optimizer,
    cookieSecure: opts.cookieSecure ?? false,
  });
  return {
    app, db, auth, settings, rounds, market, decision, history, symbols, analytics, replay, research, marketScan,
    usageGate, barFetcher, prices, optimizer,
  };
}

/** Registers the single user and returns a session cookie for authed requests. */
export async function loginCookie(ctx: TestCtx, username = 'chris', password = 'hunter22'): Promise<string> {
  await ctx.auth.createUser(username, password);
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}
