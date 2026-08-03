import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { DEFAULT_FEES, DEFAULT_GUARDRAILS, cents, type RoundConfig } from '../src/engine/types.js';
import { MarketDataService } from '../src/market/data.js';
import type { CandidateFetcher } from '../src/market/candidates.js';
import { MarketScanService } from '../src/market-scan/service.js';
import { RoundService } from '../src/rounds/service.js';
import { FakeAgentRunner } from './agent-helper.js';

function config(over: Partial<RoundConfig> = {}): RoundConfig {
  return {
    name: 'scan round', startingBalanceCents: cents(50), profitGoalCents: cents(1000),
    markets: ['US'], watchlist: [], riskProfile: 'balanced', tradingStyle: 'swing',
    guardrails: DEFAULT_GUARDRAILS, fees: DEFAULT_FEES, model: 'claude-sonnet-5',
    checkinCron: [], researchCron: [], autoWatchlist: false,
    ...over,
  };
}

const candidatesFor: CandidateFetcher = async (market) =>
  market === 'US'
    ? [{ symbol: 'AAPL', name: 'Apple', changePct: 1 }, { symbol: 'NVDA', name: 'Nvidia', changePct: 2 }]
    : [{ symbol: 'BHP.AX', name: 'BHP', changePct: 0.5 }];

function fakeQuoteFetcher(known: string[]) {
  return async (symbols: string[]) => {
    const out = new Map<string, { price: number; currency: string }>();
    for (const s of symbols) if (known.includes(s)) out.set(s, { price: 10, currency: 'USD' });
    return out;
  };
}

describe('MarketScanService', () => {
  let db: DB;
  let rounds: RoundService;
  let market: MarketDataService;
  let id: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    rounds = new RoundService(db, new PaperBroker(db));
    market = new MarketDataService(db, fakeQuoteFetcher(['AAPL', 'NVDA', 'BHP.AX']));
    id = rounds.create(config());
  });

  it('adopts a valid watchlist chosen from the candidate list', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "NVDA"]}');
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('success');
    expect(rounds.config(id).watchlist.sort()).toEqual(['AAPL', 'NVDA']);
  });

  it('requests the web tools, no trading tools, and no maxTurns explosion', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}');
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    const request = runner.requests[0]!;
    expect(request.webTools).toBe(true);
    expect(request.tools).toHaveLength(0);
    expect(request.maxTurns).toBeGreaterThan(0);
  });

  it('drops a symbol not on the candidate list (Defence 1: hallucination)', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "FAKECO"]}');
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(rounds.config(id).watchlist).toEqual(['AAPL']);
  });

  it('drops a candidate outside the round\'s configured markets (Defence 2)', async () => {
    // BHP.AX is a real candidate but this round only trades US.
    const mixedCandidates: CandidateFetcher = async () => [
      { symbol: 'AAPL' }, { symbol: 'BHP.AX' },
    ];
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "BHP.AX"]}');
    await new MarketScanService({ db, rounds, market }, runner, mixedCandidates).runScan(id);

    expect(rounds.config(id).watchlist).toEqual(['AAPL']);
  });

  it('drops a candidate-list symbol with no live quote (Defence 3)', async () => {
    const noisyMarket = new MarketDataService(db, fakeQuoteFetcher(['AAPL'])); // NVDA has no quote
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL", "NVDA"]}');
    await new MarketScanService({ db, rounds, market: noisyMarket }, runner, candidatesFor).runScan(id);

    expect(rounds.config(id).watchlist).toEqual(['AAPL']);
  });

  it('always keeps a held position\'s symbol even if the scan drops it', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), { symbol: 'AAPL', market: 'US', price: 10, currency: 'USD', ts: new Date().toISOString(), stale: false }, 1.5, 'operator');
    const runner = new FakeAgentRunner([], '{"watchlist": ["NVDA"]}'); // does not mention AAPL
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(rounds.config(id).watchlist).toContain('AAPL');
  });

  it('does not touch the watchlist when the response cannot be parsed', async () => {
    const runner = new FakeAgentRunner([], 'I could not decide.');
    const before = rounds.config(id).watchlist;
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('error');
    expect(rounds.config(id).watchlist).toEqual(before);
  });

  it('does not touch the watchlist when nothing survives validation', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["FAKECO"]}');
    const before = rounds.config(id).watchlist;
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('error');
    expect(rounds.config(id).watchlist).toEqual(before);
  });

  it('records a failed run instead of throwing', async () => {
    const runner = { run: async () => { throw new Error('web tool unavailable'); } };
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('error');
    const events = db.prepare("SELECT kind FROM event_log WHERE round_id = ? AND kind = 'market_scan_failed'").all(id);
    expect(events).toHaveLength(1);
  });

  it('skips terminal rounds without spending a token', async () => {
    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}');
    rounds.setStatus(id, 'archived', 'test');
    const outcome = await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    expect(outcome.status).toBe('skipped');
    expect(runner.requests).toHaveLength(0);
  });

  it('errors cleanly when no candidates are available for the round\'s markets', async () => {
    const noCandidates: CandidateFetcher = async () => [];
    const runner = new FakeAgentRunner([], '{"watchlist": []}');
    const outcome = await new MarketScanService({ db, rounds, market }, runner, noCandidates).runScan(id);

    expect(outcome.status).toBe('error');
    expect(runner.requests).toHaveLength(0); // never spend a token with nothing to offer
  });

  it('records added/removed symbols relative to the prior watchlist', async () => {
    rounds.buy(id, 'AAPL', 'US', cents(20), { symbol: 'AAPL', market: 'US', price: 10, currency: 'USD', ts: new Date().toISOString(), stale: false }, 1.5, 'operator');
    // seed a prior watchlist entry that the new scan will drop
    const cfg = rounds.config(id);
    db.prepare('UPDATE rounds SET config_json = ? WHERE id = ?').run(JSON.stringify({ ...cfg, watchlist: ['NVDA'] }), id);

    const runner = new FakeAgentRunner([], '{"watchlist": ["AAPL"]}'); // drops NVDA implicitly
    await new MarketScanService({ db, rounds, market }, runner, candidatesFor).runScan(id);

    const row = db.prepare('SELECT added_json, removed_json FROM market_scans WHERE round_id = ?').get(id) as {
      added_json: string; removed_json: string;
    };
    expect(JSON.parse(row.removed_json)).toContain('NVDA');
  });

  it('list() returns scans newest first', async () => {
    const service = new MarketScanService({ db, rounds, market }, new FakeAgentRunner([], '{"watchlist": ["AAPL"]}'), candidatesFor);
    await service.runScan(id);
    await service.runScan(id);
    const rows = service.list(id);
    expect(rows.length).toBe(2);
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
  });
});
