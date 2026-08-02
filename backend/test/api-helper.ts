import type { Express } from 'express';
import request from 'supertest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/api/app.js';
import { DecisionService } from '../src/agent/decision.js';
import { AuthService } from '../src/auth/service.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';
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
  prices: Record<string, { price: number; currency: string }>;
}

export function createTestApp(): TestCtx {
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
  const app = buildApp({ db, auth, settings, rounds, market, decision });
  return { app, db, auth, settings, rounds, market, decision, prices };
}

/** Registers the single user and returns a session cookie for authed requests. */
export async function loginCookie(ctx: TestCtx, username = 'chris', password = 'hunter22'): Promise<string> {
  await ctx.auth.createUser(username, password);
  const res = await request(ctx.app).post('/api/auth/login').send({ username, password });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}
