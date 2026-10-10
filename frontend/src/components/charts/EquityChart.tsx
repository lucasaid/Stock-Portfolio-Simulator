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
  /** Points are one per Sydney day: collapse each day's trades into a single marker on it. */
  daily?: boolean;
}

const sydneyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' });
const dayOf = (iso: string) => sydneyDay.format(new Date(iso));

function tradeMarker(trade: TradeRow): SeriesMarker<Time> {
  return {
    time: toChartTime(trade.executed_at),
    position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
    color: trade.side === 'buy' ? CHART_COLORS.up : CHART_COLORS.down,
    shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
    text: `${trade.side} ${trade.symbol}`,
  };
}

/** One marker per day that had trades, pinned to that day's point: "buy BTC-USD" or "2 buys, 1 sell". */
export function dailyTradeMarkers(points: EquityPoint[], trades: TradeRow[]): SeriesMarker<Time>[] {
  const pointTs = new Map(points.map((p) => [dayOf(p.ts), p.ts]));
  const byDay = new Map<string, TradeRow[]>();
  for (const trade of trades) {
    const day = dayOf(trade.executed_at);
    byDay.set(day, [...(byDay.get(day) ?? []), trade]);
  }
  const markers: SeriesMarker<Time>[] = [];
  for (const [day, dayTrades] of byDay) {
    const ts = pointTs.get(day);
    if (ts === undefined) continue;
    if (dayTrades.length === 1) {
      markers.push({ ...tradeMarker(dayTrades[0]!), time: toChartTime(ts) });
      continue;
    }
    const buys = dayTrades.filter((t) => t.side === 'buy').length;
    const sells = dayTrades.length - buys;
    const label = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    markers.push({
      time: toChartTime(ts),
      position: sells === 0 ? 'belowBar' : 'aboveBar',
      color: sells === 0 ? CHART_COLORS.up : buys === 0 ? CHART_COLORS.down : CHART_COLORS.accent,
      shape: sells === 0 ? 'arrowUp' : buys === 0 ? 'arrowDown' : 'circle',
      text: [buys && label(buys, 'buy'), sells && label(sells, 'sell')].filter(Boolean).join(', '),
    });
  }
  return markers;
}

export function EquityChart({ points, trades, extraMarkers = [], height = 260, daily = false }: EquityChartProps) {
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

    // A windowed (non-daily) view only marks trades inside its window — older ones would
    // otherwise all pile up on the first point.
    const firstTs = data.length > 0 ? points.reduce((min, p) => (p.ts < min ? p.ts : min), points[0]!.ts) : '';
    const tradeMarkers = daily
      ? dailyTradeMarkers(points, trades)
      : trades.filter((t) => t.executed_at >= firstTs).map(tradeMarker);
    const markers = [...tradeMarkers, ...extraMarkers].sort((a, b) => Number(a.time) - Number(b.time));
    createSeriesMarkers(series, markers);

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [points, trades, extraMarkers, height, daily]);

  if (points.length === 0) return <p className="muted">No equity history yet.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
