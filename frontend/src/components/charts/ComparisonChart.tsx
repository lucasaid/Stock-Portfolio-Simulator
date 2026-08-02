import { useQueries } from '@tanstack/react-query';
import { createChart, LineSeries, type IChartApi } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { apiFetch } from '../../api/client';
import { qk } from '../../api/hooks';
import type { EquityPoint } from '../../api/types';
import { baseChartOptions, toChartTime } from './chartTheme';

const SERIES_COLORS = ['#6e56cf', '#1a7f4b', '#c0392b', '#e0a020', '#2f8fd8', '#a24bd8'];

/**
 * Rounds start at different bankrolls and on different days, so raw equity is
 * not comparable. Every series is normalised to 100 at its own first snapshot.
 */
export function ComparisonChart({ roundIds, height = 300 }: { roundIds: number[]; height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const results = useQueries({
    queries: roundIds.map((id) => ({
      queryKey: qk.equity(id),
      queryFn: () => apiFetch<EquityPoint[]>(`/api/rounds/${id}/equity`),
    })),
  });

  const series = results.map((result, index) => {
    const points = [...(result.data ?? [])].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const base = points[0]?.equity_cents ?? 0;
    return {
      roundId: roundIds[index]!,
      data:
        base === 0
          ? []
          : points.map((point) => ({
              time: toChartTime(point.ts),
              // Rounded: 5500/5000*100 is 110.00000000000001 in float, which would
              // surface verbatim in the tooltip.
              value: Number(((point.equity_cents / base) * 100).toFixed(4)),
            })),
    };
  });
  // The array identity changes every render; this captures what actually matters.
  const shape = JSON.stringify(series.map((s) => [s.roundId, s.data.length]));

  useEffect(() => {
    if (container.current === null || series.every((s) => s.data.length === 0)) return;

    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;
    series.forEach((entry, index) => {
      if (entry.data.length === 0) return;
      const line = chart.addSeries(LineSeries, {
        color: SERIES_COLORS[index % SERIES_COLORS.length],
        lineWidth: 2,
        title: `round ${entry.roundId}`,
      });
      line.setData(entry.data);
    });
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };

  }, [shape, height]);

  if (roundIds.length === 0) return <p className="muted">Select at least one round to compare.</p>;
  if (series.every((s) => s.data.length === 0)) return <p className="muted">No equity history to compare yet.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
