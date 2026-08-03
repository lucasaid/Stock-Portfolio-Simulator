import { Link } from 'react-router-dom';
import { useHistory } from '../../api/hooks';
import type { PositionRow } from '../../api/types';
import { Sparkline } from '../../components/charts/Sparkline';
import { formatQty } from '../../lib/format';

/** One held symbol's recent trend. A separate component so each gets its own `useHistory` call. */
function HoldingCard({ position }: { position: PositionRow }) {
  const history = useHistory(position.symbol, '1M');
  const closes = (history.data?.bars ?? []).map((b) => b.close);
  const changePct = closes.length >= 2 ? ((closes.at(-1)! - closes[0]!) / closes[0]!) * 100 : null;

  return (
    <Link
      to={`/markets?symbol=${encodeURIComponent(position.symbol)}`}
      className="panel"
      style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{position.symbol}</strong>
        {changePct !== null && (
          <span className={changePct >= 0 ? 'gain' : 'loss'} style={{ fontSize: '0.85em' }}>
            {changePct >= 0 ? '+' : ''}
            {changePct.toFixed(1)}%
          </span>
        )}
      </div>
      <Sparkline values={closes} width={160} height={32} />
      <div className="muted" style={{ fontSize: '0.8em' }}>{formatQty(position.quantity)} shares · 1M</div>
    </Link>
  );
}

/** Held companies' recent price trend, one card per open position — click through to the full chart. */
export function HoldingsChartPanel({ positions }: { positions: PositionRow[] }) {
  if (positions.length === 0) return <p className="muted">No open positions to chart.</p>;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem' }}>
      {positions.map((position) => (
        <HoldingCard key={position.id} position={position} />
      ))}
    </div>
  );
}
