/** Pure SVG. Cards render dozens of these; a chart engine per card is not worth it. */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = 'var(--accent)',
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length === 0) return <svg width={width} height={height} aria-hidden="true" />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length === 1 ? 0 : width / (values.length - 1);

  const points = values
    .map((value, index) => {
      const x = index * step;
      // A flat series has no span to scale against — draw it down the middle.
      const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
      return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label="equity trend">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
