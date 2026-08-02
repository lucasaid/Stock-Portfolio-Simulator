import {
  CandlestickSeries, createChart, createSeriesMarkers, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { OhlcBar, TradeRow } from '../../api/types';
import { baseChartOptions, CHART_COLORS, toChartTime } from './chartTheme';

export interface PriceChartProps {
  bars: OhlcBar[];
  style: 'line' | 'candles';
  trades: TradeRow[];
  /** Simple moving-average window in bars. Undefined hides the overlay. */
  movingAverage?: number;
  height?: number;
}

function sma(bars: OhlcBar[], window: number): { time: UTCTimestamp; value: number }[] {
  if (window <= 1) return [];
  const out: { time: UTCTimestamp; value: number }[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.close;
    if (i >= window) sum -= bars[i - window]!.close;
    if (i >= window - 1) out.push({ time: toChartTime(bars[i]!.ts), value: sum / window });
  }
  return out;
}

export function PriceChart({ bars, style, trades, movingAverage, height = 340 }: PriceChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (container.current === null || bars.length === 0) return;

    const ordered = [...bars].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const chart = createChart(container.current, baseChartOptions(height));
    chartRef.current = chart;

    // Create and populate in the same branch so the series type narrows on its own —
    // candles take OHLC points, the line takes single values.
    let priceSeries: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>;
    if (style === 'candles') {
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: CHART_COLORS.up,
        downColor: CHART_COLORS.down,
        borderVisible: false,
        wickUpColor: CHART_COLORS.up,
        wickDownColor: CHART_COLORS.down,
      });
      candles.setData(
        ordered.map((bar) => ({
          time: toChartTime(bar.ts), open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        })),
      );
      priceSeries = candles;
    } else {
      const line = chart.addSeries(LineSeries, { color: CHART_COLORS.accent, lineWidth: 2 });
      line.setData(ordered.map((bar) => ({ time: toChartTime(bar.ts), value: bar.close })));
      priceSeries = line;
    }

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: CHART_COLORS.volume,
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    volumeSeries.setData(
      ordered.filter((bar) => bar.volume !== null).map((bar) => ({ time: toChartTime(bar.ts), value: bar.volume! })),
    );
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    if (movingAverage !== undefined && movingAverage > 1) {
      const maSeries = chart.addSeries(LineSeries, { color: '#e0a020', lineWidth: 1 });
      maSeries.setData(sma(ordered, movingAverage));
    }

    const markers: SeriesMarker<Time>[] = trades.map((trade) => ({
      time: toChartTime(trade.executed_at),
      position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: trade.side === 'buy' ? CHART_COLORS.up : CHART_COLORS.down,
      shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: `${trade.side} ${trade.quantity} @ ${trade.price_aud.toFixed(2)}`,
    }));
    createSeriesMarkers(priceSeries, [...markers].sort((a, b) => Number(a.time) - Number(b.time)));

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, style, trades, movingAverage, height]);

  if (bars.length === 0) return <p className="muted">No price history for this symbol.</p>;
  return <div ref={container} style={{ width: '100%', height }} />;
}
