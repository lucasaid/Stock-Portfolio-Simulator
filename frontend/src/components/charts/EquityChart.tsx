import {
  AreaSeries, createChart, createSeriesMarkers,
  type IChartApi, type SeriesMarker, type Time,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { EquityPoint, TradeRow } from '../../api/types';
import { baseChartOptions, CHART_COLORS, toChartTime } from './chartTheme';

export interface EquityChartProps {
  points: EquityPoint[];
  trades: TradeRow[];
  /** Extra markers: skims, guardrail firings, config changes (spec §6). */
  extraMarkers?: SeriesMarker<Time>[];
  height?: number;
}

export function EquityChart({ points, trades, extraMarkers = [], height = 260 }: EquityChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (container.current === null || points.length === 0) return;

    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;
    const series = chart.addSeries(AreaSeries, {
      lineColor: CHART_COLORS.accent,
      topColor: 'rgba(110, 86, 207, 0.35)',
      bottomColor: 'rgba(110, 86, 207, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    // The API serves newest-first; charts need oldest-first.
    const data = [...points]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .map((point) => ({ time: toChartTime(point.ts), value: point.equity_cents / 100 }));
    series.setData(data);

    const tradeMarkers: SeriesMarker<Time>[] = trades.map((trade) => ({
      time: toChartTime(trade.executed_at),
      position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: trade.side === 'buy' ? CHART_COLORS.up : CHART_COLORS.down,
      shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: `${trade.side} ${trade.symbol}`,
    }));
    const markers = [...tradeMarkers, ...extraMarkers].sort((a, b) => Number(a.time) - Number(b.time));
    createSeriesMarkers(series, markers);

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [points, trades, extraMarkers, height]);

  if (points.length === 0) return <p className="muted">No equity history yet.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
