import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyTradeMarkers, EquityChart } from '../src/components/charts/EquityChart';
import { PriceChart } from '../src/components/charts/PriceChart';
import { Sparkline } from '../src/components/charts/Sparkline';
import type { EquityPoint, OhlcBar, TradeRow } from '../src/api/types';

const series = {
  setData: vi.fn(),
  priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
};
const chart = {
  // Typed params so `mock.calls[n][0]` is the series definition, not `never`.
  addSeries: vi.fn((_definition: unknown, _options?: unknown) => series),
  applyOptions: vi.fn(),
  priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  remove: vi.fn(),
};
const createSeriesMarkers = vi.fn();

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => chart),
  createSeriesMarkers: (...args: unknown[]) => createSeriesMarkers(...args),
  AreaSeries: 'AreaSeries',
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  LineSeries: 'LineSeries',
  ColorType: { Solid: 'solid' },
}));

const equity: EquityPoint[] = [
  { id: 1, round_id: 1, ts: '2026-08-01T00:00:00.000Z', cash_cents: 5000, holdings_cents: 0, equity_cents: 5000 },
  { id: 2, round_id: 1, ts: '2026-08-02T00:00:00.000Z', cash_cents: 3000, holdings_cents: 2500, equity_cents: 5500 },
];

const trades: TradeRow[] = [
  {
    id: 1, order_id: 1, round_id: 1, symbol: 'AAPL', side: 'buy', quantity: 2,
    price_aud: 10, gross_cents: 2000, fee_cents: 0, executed_at: '2026-08-01T12:00:00.000Z',
  },
];

const bars: OhlcBar[] = [
  { ts: '2026-08-01T00:00:00.000Z', open: 9, high: 11, low: 8, close: 10, volume: 100 },
  { ts: '2026-08-02T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 120 },
];

describe('charts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Sparkline draws a polyline through the values', () => {
    const { container } = render(<Sparkline values={[100, 120, 90, 150]} width={80} height={20} />);
    const polyline = container.querySelector('polyline')!;
    const points = polyline.getAttribute('points')!.split(' ');
    expect(points).toHaveLength(4);
    expect(points[0]!.startsWith('0,')).toBe(true);
    expect(points[3]!.startsWith('80,')).toBe(true);
  });

  it('Sparkline renders a flat line when every value is identical', () => {
    const { container } = render(<Sparkline values={[100, 100, 100]} width={60} height={20} />);
    const ys = container
      .querySelector('polyline')!
      .getAttribute('points')!
      .split(' ')
      .map((p) => p.split(',')[1]);
    expect(new Set(ys).size).toBe(1);
  });

  it('Sparkline renders nothing for an empty series', () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('EquityChart feeds dollar values in chronological order', () => {
    render(<EquityChart points={[...equity].reverse()} trades={[]} />);
    const data = series.setData.mock.calls[0]![0] as { time: number; value: number }[];
    expect(data.map((d) => d.value)).toEqual([50, 55]);
    expect(data[0]!.time).toBeLessThan(data[1]!.time);
  });

  it('EquityChart places a marker per trade', () => {
    render(<EquityChart points={equity} trades={trades} />);
    const markers = createSeriesMarkers.mock.calls[0]![1] as { text: string; position: string }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain('AAPL');
    expect(markers[0]!.position).toBe('belowBar');
  });

  it('EquityChart shows an empty state instead of a chart with no data', () => {
    render(<EquityChart points={[]} trades={[]} />);
    expect(screen.getByText(/no equity history/i)).toBeInTheDocument();
  });

  it('PriceChart renders candles plus a volume series', () => {
    render(<PriceChart bars={bars} style="candles" trades={[]} />);
    const seriesTypes = chart.addSeries.mock.calls.map((call) => call[0]);
    expect(seriesTypes).toContain('CandlestickSeries');
    expect(seriesTypes).toContain('HistogramSeries');
  });

  it('PriceChart renders a line series in line mode', () => {
    render(<PriceChart bars={bars} style="line" trades={[]} />);
    const seriesTypes = chart.addSeries.mock.calls.map((call) => call[0]);
    expect(seriesTypes).toContain('LineSeries');
    expect(seriesTypes).not.toContain('CandlestickSeries');
  });

  it('PriceChart adds a moving-average series when asked', () => {
    render(<PriceChart bars={bars} style="line" trades={[]} movingAverage={2} />);
    const lineCalls = chart.addSeries.mock.calls.filter((call) => call[0] === 'LineSeries');
    expect(lineCalls.length).toBe(2);
  });

  it('PriceChart tears the chart down on unmount', () => {
    const { unmount } = render(<PriceChart bars={bars} style="line" trades={[]} />);
    unmount();
    expect(chart.remove).toHaveBeenCalled();
  });
});

describe('dailyTradeMarkers', () => {
  const point = (ts: string): EquityPoint => ({ id: 0, round_id: 1, ts, cash_cents: 0, holdings_cents: 0, equity_cents: 0 });
  const trade = (executed_at: string, side: 'buy' | 'sell', symbol = 'BTC-USD') =>
    ({ id: 0, order_id: 0, round_id: 1, symbol, side, quantity: 1, price_aud: 1, gross_cents: 0, fee_cents: 0, executed_at }) satisfies TradeRow;

  it('collapses each Sydney day of trades into one marker on that day’s point', () => {
    // 3 Aug Sydney ends at 14:00Z; 4 Aug's point is its last snapshot.
    const points = [point('2026-08-03T13:55:00.000Z'), point('2026-08-04T13:00:00.000Z')];
    const markers = dailyTradeMarkers(points, [
      trade('2026-08-03T02:00:00.000Z', 'buy', 'ETH-USD'),
      trade('2026-08-04T01:00:00.000Z', 'buy'),
      trade('2026-08-04T03:00:00.000Z', 'buy'),
      trade('2026-08-04T05:00:00.000Z', 'sell'),
    ]);
    expect(markers.map((m) => [m.time, m.text, m.shape])).toEqual([
      [Date.parse('2026-08-03T13:55:00.000Z') / 1000, 'buy ETH-USD', 'arrowUp'],
      [Date.parse('2026-08-04T13:00:00.000Z') / 1000, '2 buys, 1 sell', 'circle'],
    ]);
  });
});
