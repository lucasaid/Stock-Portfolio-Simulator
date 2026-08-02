import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { SymbolRegistry } from '../src/market/symbols.js';

describe('SymbolRegistry', () => {
  let db: DB;
  let registry: SymbolRegistry;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    registry = new SymbolRegistry(db);
  });

  it('tracks a symbol with its derived market', () => {
    registry.track('BHP.AX');
    expect(registry.list()).toEqual([
      expect.objectContaining({ symbol: 'BHP.AX', market: 'ASX', archived: 0 }),
    ]);
  });

  it('upper-cases and de-duplicates', () => {
    registry.track('aapl');
    registry.track('AAPL');
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.symbol).toBe('AAPL');
  });

  it('trackMany records every symbol once', () => {
    registry.trackMany(['AAPL', 'MSFT', 'AAPL']);
    expect(registry.list().map((s) => s.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('archives and unarchives without losing the row', () => {
    registry.track('AAPL');
    registry.setArchived('AAPL', true);
    expect(registry.list()[0]!.archived).toBe(1);
    expect(registry.activeSymbols()).toEqual([]);
    registry.setArchived('AAPL', false);
    expect(registry.activeSymbols()).toEqual(['AAPL']);
  });

  it('re-tracking an archived symbol does not silently unarchive it', () => {
    registry.track('AAPL');
    registry.setArchived('AAPL', true);
    registry.track('AAPL');
    expect(registry.list()[0]!.archived).toBe(1);
  });

  it('rejects a malformed symbol', () => {
    expect(registry.track('no spaces')).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it('records when a symbol was last polled', () => {
    registry.track('AAPL');
    registry.markPolled(['AAPL'], new Date('2026-08-02T03:00:00.000Z'));
    expect(registry.list()[0]!.last_polled_at).toBe('2026-08-02T03:00:00.000Z');
  });
});
