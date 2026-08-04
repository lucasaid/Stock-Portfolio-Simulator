import { useState } from 'react';
import { useMarketCandidates } from '../api/hooks';
import type { Market } from '../api/types';

const SHUFFLE_COUNT = 5;

function pickRandom(pool: string[], count: number): string[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, count);
}

/**
 * Watchlist text input plus a "Shuffle" button that fills it with a random selection drawn
 * from ALL currently-active symbols in the round's selected markets (the Yahoo screener pool
 * market-scan itself uses — most_actives + day_gainers), not just the handful already tracked
 * in our own `symbols` table. Fetched on click only — never on mount — since it's a real
 * network call to Yahoo, not local state.
 */
export function WatchlistField({
  value,
  onChange,
  markets,
}: {
  value: string;
  onChange: (next: string) => void;
  markets: Market[];
}) {
  const candidates = useMarketCandidates();
  // Tracked separately from react-query's mutation state: a successful-but-empty response
  // (a real case — the ASX screener region call doesn't reliably return .AX symbols) must be
  // distinguishable from "never shuffled yet" and must clear itself on the next attempt.
  const [empty, setEmpty] = useState(false);

  return (
    <label>
      Watchlist (comma separated)
      <div className="row">
        <input value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1 }} />
        <button
          type="button"
          disabled={markets.length === 0 || candidates.isPending}
          title={markets.length === 0 ? 'Select at least one market first' : undefined}
          onClick={() => {
            setEmpty(false);
            candidates.mutate(markets, {
              onSuccess: (pool) => {
                const symbols = pool.map((c) => c.symbol);
                if (symbols.length === 0) {
                  setEmpty(true);
                  return;
                }
                onChange(pickRandom(symbols, Math.min(SHUFFLE_COUNT, symbols.length)).join(', '));
              },
            });
          }}
        >
          {candidates.isPending ? 'Shuffling…' : 'Shuffle'}
        </button>
      </div>
      {candidates.isError && <small className="loss">{candidates.error.message}</small>}
      {empty && <small className="muted">No active symbols found for the selected market(s) right now.</small>}
    </label>
  );
}
