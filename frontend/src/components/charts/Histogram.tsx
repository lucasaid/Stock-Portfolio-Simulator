import type { ReturnBucket } from '../../api/analytics';

const WIN = '#1a7f4b';
const LOSS = '#c0392b';

/** Pure SVG: a bar chart of a handful of buckets does not need a chart engine. */
export function Histogram({
  buckets,
  width = 420,
  height = 140,
}: {
  buckets: ReturnBucket[];
  width?: number;
  height?: number;
}) {
  if (buckets.length === 0) return <p className="muted">No closed trades to plot yet.</p>;

  const max = Math.max(...buckets.map((b) => b.count));
  const barWidth = width / buckets.length;

  return (
    <figure style={{ margin: 0 }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Distribution of trade returns">
        {buckets.map((bucket, index) => {
          const barHeight = max === 0 ? 0 : (bucket.count / max) * height;
          return (
            <rect
              key={bucket.fromPct}
              className="bar"
              x={index * barWidth + 1}
              y={height - barHeight}
              width={Math.max(1, barWidth - 2)}
              height={barHeight}
              fill={bucket.fromPct < 0 ? LOSS : WIN}
            >
              <title>{`${bucket.fromPct}% to ${bucket.toPct}%: ${bucket.count} trade(s)`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="row muted" style={{ justifyContent: 'space-between', fontSize: '0.8em' }}>
        <span>{buckets[0]!.fromPct}%</span>
        <span>return per closed trade</span>
        <span>{buckets[buckets.length - 1]!.toPct}%</span>
      </figcaption>
    </figure>
  );
}
