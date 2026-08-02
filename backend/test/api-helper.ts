import type { Express } from 'express';
import request from 'supertest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/api/app.js';
import { DecisionService } from '../src/agent/decision.js';
import { AuthService } from '../src/auth/service.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
import { MarketHistoryService, type BarFetcher } from '../src/market/history.js';
import { SymbolRegistry } from '../src/market/symbols.js';
import { RoundService } from '../src/rounds/service.js';
import { SettingsStore } from '../src/settings/store.js';
import { FakeAgentRunner } from './agent-helper.js';

export interface TestCtx {
  app: Express;
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
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
  const rounds = new RoundService(db, new PaperBroker(db));
  const market = new MarketDataService(db, fetcher);
  const decision = new DecisionService(
    { db, rounds, market },
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

  const app = buildApp({
    db, auth, settings, rounds, market, decision, history, symbols,
    cookieSecure: opts.cookieSecure ?? false,
  });
  return { app, db, auth, settings, rounds, market, decision, history, symbols, barFetcher, prices };
}

/** Registers the single user and returns a session cookie for authed requests. */
export async function loginCookie(ctx: TestCtx, username = 'chris', password = 'hunter22'): Promise<string> {
  await ctx.auth.createUser(username, password);
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}
