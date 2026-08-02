import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import type { PositionRow, Quote } from '../../api/types';
import { Money } from '../../components/Money';
import { formatQty } from '../../lib/format';

function useQuotes(symbols: string[]) {
  const key = [...symbols].sort().join(',');
  return useQuery({
    queryKey: ['quotes', key],
    queryFn: () => apiFetch<Record<string, Quote>>(`/api/market/quotes?symbols=${encodeURIComponent(key)}`),
    enabled: key !== '',
    refetchInterval: 60_000,
  });
}

export function PositionsTable({ positions }: { positions: PositionRow[] }) {
  const quotes = useQuotes(positions.map((p) => p.symbol));

  if (positions.length === 0) return <p className="muted">No open positions.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th className="num">Qty</th>
          <th className="num">Cost basis</th>
          <th className="num">Last</th>
          <th className="num">Unrealised</th>
          <th className="num">Stop</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const quote = quotes.data?.[position.symbol];
          // Positions are valued in AUD cents; USD quotes are converted server-side
          // at fill time, so only show unrealised P/L for AUD-quoted holdings.
          const marketCents =
            quote && quote.currency === 'AUD' ? Math.round(position.quantity * quote.price * 100) : null;
          const unrealised = marketCents === null ? null : marketCents - position.cost_basis_cents;
          return (
            <tr key={position.id}>
              <td>{position.symbol}</td>
              <td className="num">{formatQty(position.quantity)}</td>
              <td className="num">
                <Money cents={position.cost_basis_cents} />
              </td>
              <td className="num">
                {quote ? `${quote.price.toFixed(2)} ${quote.currency}${quote.stale ? ' (stale)' : ''}` : '—'}
              </td>
              <td className="num">{unrealised === null ? '—' : <Money cents={unrealised} signed />}</td>
              <td className="num">{position.stop_loss_price === null ? '—' : position.stop_loss_price.toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
