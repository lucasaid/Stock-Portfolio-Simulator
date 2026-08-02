import type { TradeRow } from '../../api/types';
import { Money } from '../../components/Money';
import { formatQty, formatTs } from '../../lib/format';

export function TradesTable({ trades }: { trades: TradeRow[] }) {
  if (trades.length === 0) return <p className="muted">No trades yet.</p>;
  const rows = [...trades].sort((a, b) => b.id - a.id);

  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Side</th>
          <th>Symbol</th>
          <th className="num">Qty</th>
          <th className="num">Price (AUD)</th>
          <th className="num">Gross</th>
          <th className="num">Fee</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((trade) => (
          <tr key={trade.id}>
            <td>{formatTs(trade.executed_at)}</td>
            <td className={trade.side === 'buy' ? 'gain' : 'loss'}>{trade.side}</td>
            <td>{trade.symbol}</td>
            <td className="num">{formatQty(trade.quantity)}</td>
            <td className="num">{trade.price_aud.toFixed(4)}</td>
            <td className="num">
              <Money cents={trade.gross_cents} />
            </td>
            <td className="num">
              <Money cents={trade.fee_cents} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
