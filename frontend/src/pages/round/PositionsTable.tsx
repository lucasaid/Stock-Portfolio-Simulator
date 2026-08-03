import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import { qk, useFxRate } from '../../api/hooks';
import type { PositionRow, Quote } from '../../api/types';
import { Money } from '../../components/Money';
import { formatQty } from '../../lib/format';

function useQuotes(symbols: string[]) {
  const key = [...symbols].sort().join(',');
  return useQuery({
    queryKey: qk.quotes(symbols),
    queryFn: () => apiFetch<Record<string, Quote>>(`/api/market/quotes?symbols=${encodeURIComponent(key)}`),
    enabled: key !== '',
    refetchInterval: 60_000,
  });
}

export function PositionsTable({ positions }: { positions: PositionRow[] }) {
  const quotes = useQuotes(positions.map((p) => p.symbol));
  const fx = useFxRate();

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
          // Cost bases are AUD cents. A USD quote is converted with the same rate the
          // broker uses at fill time (AUD price = USD price / USD-per-AUD); without a
          // rate we show nothing rather than a number that is wrong by ~50%.
          const audUsd = fx.data?.audUsd;
          const priceAud =
            quote === undefined
              ? null
              : quote.currency === 'AUD'
                ? quote.price
                : audUsd === undefined || audUsd <= 0
                  ? null
                  : quote.price / audUsd;
          const marketCents = priceAud === null ? null : Math.round(position.quantity * priceAud * 100);
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
