import { createChart, LineSeries, type IChartApi } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { useBenchmark } from '../../api/analytics';
import { ErrorBox } from '../ErrorBox';
import { Spinner } from '../Spinner';
import { baseChartOptions, CHART_COLORS, toChartTime } from './chartTheme';

export function BenchmarkChart({ roundId, height = 220 }: { roundId: number; height?: number }) {
  const benchmark = useBenchmark(roundId);
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const points = benchmark.data?.points ?? [];

  useEffect(() => {
    if (container.current === null || points.length === 0) return;

    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;

    const equity = chart.addSeries(LineSeries, { color: CHART_COLORS.accent, lineWidth: 2 });
    equity.setData(points.map((p) => ({ time: toChartTime(p.ts), value: p.equityCents / 100 })));

    // Dashed and grey: the index is the reference line, not the subject.
    const index = chart.addSeries(LineSeries, { color: '#8a8a95', lineWidth: 1, lineStyle: 2 });
    index.setData(
      points
        .filter((p) => p.benchmarkCents !== null)
        .map((p) => ({ time: toChartTime(p.ts), value: p.benchmarkCents! / 100 })),
    );

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [points, height]);

  if (benchmark.isPending) return <Spinner label="Loading benchmark" />;
  if (benchmark.error) return <ErrorBox error={benchmark.error} />;
  if (!benchmark.data) return null;

  const { roundReturnPct, benchmarkReturnPct, symbol } = benchmark.data;
  if (points.length === 0 || roundReturnPct === null) {
    return <p className="muted">Not enough history to compare against {symbol} yet.</p>;
  }

  const ahead = benchmarkReturnPct === null ? null : roundReturnPct >= benchmarkReturnPct;
  const signed = (pct: number): string => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <div className="row" style={{ gap: '1rem' }}>
        <span className={roundReturnPct >= 0 ? 'gain' : 'loss'}>Round {signed(roundReturnPct)}</span>
        <span className="muted">
          {symbol} {benchmarkReturnPct === null ? '—' : signed(benchmarkReturnPct)}
        </span>
        {ahead !== null && (
          <span className={ahead ? 'gain' : 'loss'}>{ahead ? 'ahead of the index' : 'behind the index'}</span>
        )}
      </div>
      <div ref={container} style={{ width: '100%', height }} />
    </div>
  );
}
