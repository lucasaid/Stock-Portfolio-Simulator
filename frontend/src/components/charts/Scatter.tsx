import type { ScatterPoint } from '../../api/analytics';

const WIN = '#1a7f4b';
const LOSS = '#c0392b';
const PAD = 6;

function days(ms: number): number {
  return ms / 86_400_000;
}

/** Hold time (x) against return (y). Pure SVG, so jsdom can assert on it. */
export function Scatter({
  points,
  width = 420,
  height = 200,
}: {
  points: ScatterPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return <p className="muted">No closed trades to plot yet.</p>;

  const xs = points.map((p) => days(p.holdMs));
  const ys = points.map((p) => p.returnPct);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  // A single point (or a flat axis) has no range to scale against — centre it.
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const zeroY = PAD + ((yMax - 0) / ySpan) * (height - 2 * PAD);

  return (
    <figure style={{ margin: 0 }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Hold time versus return">
        <line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth={1} />
        {points.map((point, index) => {
          const cx = PAD + ((days(point.holdMs) - xMin) / xSpan) * (width - 2 * PAD);
          const cy = PAD + ((yMax - point.returnPct) / ySpan) * (height - 2 * PAD);
          return (
            <circle
              key={`${point.closedAt}-${index}`}
              cx={cx}
              cy={cy}
              r={4}
              fill={point.netCents >= 0 ? WIN : LOSS}
              opacity={0.8}
            >
              <title>{`${point.symbol}: ${point.returnPct.toFixed(1)}% after ${days(point.holdMs).toFixed(1)} days`}</title>
            </circle>
          );
        })}
      </svg>
      <figcaption className="row muted" style={{ justifyContent: 'space-between', fontSize: '0.8em' }}>
        <span>{xMin.toFixed(1)}d</span>
        <span>hold time vs return</span>
        <span>{xMax.toFixed(1)}d</span>
      </figcaption>
    </figure>
  );
}
