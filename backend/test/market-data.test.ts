import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MarketDataService, type QuoteFetcher } from '../src/market/data.js';

function fakeFetcher(prices: Record<string, { price: number; currency: string; name?: string }>): QuoteFetcher {
  return async (symbols) => {
    const out = new Map<string, { price: number; currency: string; name?: string }>();
    for (const s of symbols) if (prices[s]) out.set(s, prices[s]);
    return out;
  };
}

describe('MarketDataService', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('polls quotes, caches them, and persists price bars', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD' }, 'BHP.AX': { price: 40, currency: 'AUD' } }));
    const quotes = await svc.poll(['AAPL', 'BHP.AX']);
    expect(quotes.get('AAPL')).toMatchObject({ symbol: 'AAPL', market: 'US', price: 150, currency: 'USD', stale: false });
    expect(quotes.get('BHP.AX')).toMatchObject({ market: 'ASX', price: 40, currency: 'AUD' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM price_bars').get()).toEqual({ c: 2 });
  });

  it('marks cached quotes stale after the threshold', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD' } }), 0); // stale immediately
    await svc.poll(['AAPL']);
    await new Promise((r) => setTimeout(r, 5));
    const quotes = svc.latest(['AAPL']);
    expect(quotes.get('AAPL')?.stale).toBe(true);
  });

  it('omits symbols the fetcher could not price', async () => {
    const svc = new MarketDataService(db, fakeFetcher({}));
    const quotes = await svc.poll(['MISSING']);
    expect(quotes.has('MISSING')).toBe(false);
  });

  it('fetches the AUDUSD rate', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AUDUSD=X': { price: 0.65, currency: 'USD' } }));
    expect(await svc.audUsdRate()).toBe(0.65);
  });

  it('throws when the AUDUSD rate is unavailable', async () => {
    const svc = new MarketDataService(db, fakeFetcher({}));
    await expect(svc.audUsdRate()).rejects.toThrow(/AUDUSD/);
  });

  it('backfills a tracked symbol\'s name from the quote when it has none yet', async () => {
    db.prepare('INSERT INTO symbols (symbol, market, name, archived) VALUES (?, ?, NULL, 0)').run('AAPL', 'US');
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD', name: 'Apple Inc.' } }));

    await svc.poll(['AAPL']);

    const row = db.prepare('SELECT name FROM symbols WHERE symbol = ?').get('AAPL') as { name: string | null };
    expect(row.name).toBe('Apple Inc.');
  });

  it('never overwrites an existing symbol name', async () => {
    db.prepare('INSERT INTO symbols (symbol, market, name, archived) VALUES (?, ?, ?, 0)').run('AAPL', 'US', 'Custom Name');
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD', name: 'Apple Inc.' } }));

    await svc.poll(['AAPL']);

    const row = db.prepare('SELECT name FROM symbols WHERE symbol = ?').get('AAPL') as { name: string | null };
    expect(row.name).toBe('Custom Name');
  });

  it('does not insert a symbols row for an untracked symbol', async () => {
    const svc = new MarketDataService(db, fakeFetcher({ 'AAPL': { price: 150, currency: 'USD', name: 'Apple Inc.' } }));

    await svc.poll(['AAPL']);

    expect(db.prepare('SELECT 1 FROM symbols WHERE symbol = ?').get('AAPL')).toBeUndefined();
  });
});
