import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonChart } from '../src/components/charts/ComparisonChart';
import { renderWithProviders } from './render';
import { server } from './server';

const setData = vi.fn();
const addSeries = vi.fn((_definition: unknown, _options?: unknown) => ({ setData }));
const remove = vi.fn();
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: (...args: unknown[]) => addSeries(args[0], args[1]),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    remove: () => remove(),
  })),
  createSeriesMarkers: vi.fn(),
  AreaSeries: 'AreaSeries',
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  LineSeries: 'LineSeries',
  ColorType: { Solid: 'solid' },
}));

function equity(roundId: number, values: number[]) {
  return values.map((equity_cents, i) => ({
    id: i + 1,
    round_id: roundId,
    ts: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString(),
    cash_cents: equity_cents,
    holdings_cents: 0,
    equity_cents,
  }));
}

describe('ComparisonChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalises each round to 100 at its own first snapshot', async () => {
    server.use(
      http.get('/api/rounds/1/equity', () => HttpResponse.json(equity(1, [5000, 5500, 6000]))),
      http.get('/api/rounds/2/equity', () => HttpResponse.json(equity(2, [20000, 10000]))),
    );
    renderWithProviders(<ComparisonChart roundIds={[1, 2]} />);

    await waitFor(() => expect(addSeries).toHaveBeenCalledTimes(2));
    // Different bankrolls, same scale: both start at 100.
    expect((setData.mock.calls[0]![0] as { value: number }[]).map((p) => p.value)).toEqual([100, 110, 120]);
    expect((setData.mock.calls[1]![0] as { value: number }[]).map((p) => p.value)).toEqual([100, 50]);
  });

  it('sorts snapshots oldest-first before normalising', async () => {
    server.use(
      http.get('/api/rounds/1/equity', () => HttpResponse.json([...equity(1, [5000, 6000])].reverse())),
    );
    renderWithProviders(<ComparisonChart roundIds={[1]} />);

    await waitFor(() => expect(setData).toHaveBeenCalled());
    expect((setData.mock.calls[0]![0] as { value: number }[]).map((p) => p.value)).toEqual([100, 120]);
  });

  it('prompts when nothing is selected', () => {
    renderWithProviders(<ComparisonChart roundIds={[]} />);
    expect(screen.getByText(/select at least one round/i)).toBeInTheDocument();
  });

  it('explains an empty history rather than rendering a blank chart', async () => {
    server.use(http.get('/api/rounds/1/equity', () => HttpResponse.json([])));
    renderWithProviders(<ComparisonChart roundIds={[1]} />);

    expect(await screen.findByText(/no equity history to compare/i)).toBeInTheDocument();
  });

  it('skips a round whose first snapshot is zero instead of dividing by it', async () => {
    server.use(
      http.get('/api/rounds/1/equity', () => HttpResponse.json(equity(1, [0, 100]))),
      http.get('/api/rounds/2/equity', () => HttpResponse.json(equity(2, [5000, 5500]))),
    );
    renderWithProviders(<ComparisonChart roundIds={[1, 2]} />);

    await waitFor(() => expect(addSeries).toHaveBeenCalledTimes(1));
    const values = (setData.mock.calls[0]![0] as { value: number }[]).map((p) => p.value);
    expect(values).toEqual([100, 110]);
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('tears the chart down on unmount', async () => {
    server.use(http.get('/api/rounds/1/equity', () => HttpResponse.json(equity(1, [5000, 5500]))));
    const { unmount } = renderWithProviders(<ComparisonChart roundIds={[1]} />);

    await waitFor(() => expect(addSeries).toHaveBeenCalled());
    unmount();
    expect(remove).toHaveBeenCalled();
  });
});
