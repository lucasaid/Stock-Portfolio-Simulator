import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { MarketHistoryService, type BarFetcher, type OhlcBar } from '../src/market/history.js';

const T0 = new Date('2026-08-02T00:00:00.000Z');

function bars(n: number, from = T0): OhlcBar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(from.getTime() + i * 86_400_000).toISOString(),
    open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1000 + i,
  }));
}

describe('MarketHistoryService', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('fetches, caches and returns bars', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    const result = await svc.history('AAPL', '1M', T0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.interval).toBe('1d');
    expect(result.currency).toBe('USD');
    expect(result.bars).toHaveLength(3);
    expect(result.bars[0]!.close).toBe(10.5);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM ohlc_bars').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('serves the cache without refetching inside the TTL', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    const second = await svc.history('AAPL', '1M', new Date(T0.getTime() + 60_000));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.bars).toHaveLength(3);
  });

  it('refetches once the TTL has expired', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    await svc.history('AAPL', '1M', new Date(T0.getTime() + 13 * 3_600_000));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('upserts rather than duplicating an overlapping refetch', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    await svc.history('AAPL', '1M', new Date(T0.getTime() + 13 * 3_600_000));

    const rows = db.prepare('SELECT COUNT(*) AS c FROM ohlc_bars').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('drops bars with non-finite or non-positive prices', async () => {
    const bad: OhlcBar[] = [
      { ts: T0.toISOString(), open: 10, high: 11, low: 9, close: 10.5, volume: 1 },
      { ts: new Date(T0.getTime() + 86_400_000).toISOString(), open: 0, high: 0, low: 0, close: 0, volume: 1 },
      { ts: new Date(T0.getTime() + 2 * 86_400_000).toISOString(), open: 1, high: NaN, low: 1, close: 1, volume: 1 },
    ];
    const svc = new MarketHistoryService(db, async () => ({ currency: 'USD', bars: bad }));

    const result = await svc.history('AAPL', '1M', T0);

    expect(result.bars).toHaveLength(1);
  });

  it('falls back to cached bars when the fetch fails', async () => {
    let fail = false;
    const svc = new MarketHistoryService(db, async () => {
      if (fail) throw new Error('yahoo down');
      return { currency: 'USD', bars: bars(3) };
    });

    await svc.history('AAPL', '1M', T0);
    fail = true;
    const result = await svc.history('AAPL', '1M', new Date(T0.getTime() + 13 * 3_600_000));

    expect(result.bars).toHaveLength(3);
    expect(result.stale).toBe(true);
  });

  it('rethrows when the fetch fails and nothing is cached', async () => {
    const svc = new MarketHistoryService(db, async () => {
      throw new Error('yahoo down');
    });

    await expect(svc.history('AAPL', '1M', T0)).rejects.toThrow('yahoo down');
  });

  it('does not serve a narrower range\'s cache to a wider range sharing the same interval', async () => {
    // 1M and 3M both fetch daily ('1d') bars but with different lookback windows. Fetching 1M
    // first must not cause the immediately-following 3M request to be served 1M's narrower
    // cached window just because the (symbol, interval) bucket has fresh, non-empty rows.
    const fetcher = vi.fn<BarFetcher>(async (_symbol, opts) => {
      const days = opts.period1 <= new Date(T0.getTime() - 90 * 86_400_000) ? 93 : 31;
      return { currency: 'USD', bars: bars(days, new Date(T0.getTime() - (days - 1) * 86_400_000)) };
    });
    const svc = new MarketHistoryService(db, fetcher);

    const oneMonth = await svc.history('AAPL', '1M', T0);
    const threeMonth = await svc.history('AAPL', '3M', new Date(T0.getTime() + 60_000));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(oneMonth.bars).toHaveLength(31);
    expect(threeMonth.bars).toHaveLength(93);
  });

  it('serves 1M from cache after 3M already covered the wider window', async () => {
    const fetcher = vi.fn<BarFetcher>(async (_symbol, opts) => {
      const days = opts.period1 <= new Date(T0.getTime() - 90 * 86_400_000) ? 93 : 31;
      return { currency: 'USD', bars: bars(days, new Date(T0.getTime() - (days - 1) * 86_400_000)) };
    });
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '3M', T0);
    const oneMonth = await svc.history('AAPL', '1M', new Date(T0.getTime() + 60_000));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(oneMonth.bars).toHaveLength(31);
  });

  it('keys the cache per interval so ranges do not collide', async () => {
    const fetcher = vi.fn<BarFetcher>(async () => ({ currency: 'USD', bars: bars(3) }));
    const svc = new MarketHistoryService(db, fetcher);

    await svc.history('AAPL', '1M', T0);
    await svc.history('AAPL', '1D', T0);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const intervals = db.prepare('SELECT DISTINCT interval FROM ohlc_bars ORDER BY interval').all() as { interval: string }[];
    expect(intervals.map((r) => r.interval)).toEqual(['1d', '5m']);
  });
});
