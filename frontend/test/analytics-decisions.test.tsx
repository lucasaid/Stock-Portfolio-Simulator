import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { BenchmarkChart } from '../src/components/charts/BenchmarkChart';
import { CheckinLedger } from '../src/pages/round/CheckinLedger';
import { DecisionsTable } from '../src/pages/round/DecisionsTable';
import { renderWithProviders } from './render';
import { benchmarkFixture, roundAnalyticsFixture, server } from './server';

const setData = vi.fn();
const addSeries = vi.fn((_definition: unknown, _options?: unknown) => ({
  setData,
  priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
}));
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: (...args: unknown[]) => addSeries(args[0], args[1]),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    remove: vi.fn(),
  })),
  createSeriesMarkers: vi.fn(),
  AreaSeries: 'AreaSeries',
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  LineSeries: 'LineSeries',
  ColorType: { Solid: 'solid' },
}));

describe('benchmark chart', () => {
  it('summarises who is ahead', async () => {
    renderWithProviders(<BenchmarkChart roundId={1} />);

    expect(await screen.findByText(/round \+8\.0%/i)).toBeInTheDocument();
    expect(screen.getByText(/IVV \+4\.0%/i)).toBeInTheDocument();
    expect(screen.getByText(/ahead of the index/i)).toBeInTheDocument();
  });

  it('says when the round is behind', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id/benchmark', () =>
        HttpResponse.json({ ...benchmarkFixture, roundReturnPct: 1, benchmarkReturnPct: 9 }),
      ),
    );
    renderWithProviders(<BenchmarkChart roundId={1} />);

    expect(await screen.findByText(/behind the index/i)).toBeInTheDocument();
  });

  it('plots both series', async () => {
    setData.mockClear();
    addSeries.mockClear();
    renderWithProviders(<BenchmarkChart roundId={1} />);
    await screen.findByText(/round \+8\.0%/i);

    expect(addSeries).toHaveBeenCalledTimes(2);
    const equity = setData.mock.calls[0]![0] as { value: number }[];
    expect(equity.map((p) => p.value)).toEqual([50, 54]);
  });

  it('explains a missing benchmark instead of drawing nothing', async () => {
    server.use(
      http.get('/api/analytics/rounds/:id/benchmark', () =>
        HttpResponse.json({ symbol: 'IVV', points: [], roundReturnPct: null, benchmarkReturnPct: null }),
      ),
    );
    renderWithProviders(<BenchmarkChart roundId={1} />);

    expect(await screen.findByText(/not enough history/i)).toBeInTheDocument();
  });
});

describe('decisions table', () => {
  it('lists each decision with its forward returns and verdict', async () => {
    renderWithProviders(<DecisionsTable roundId={1} />);

    const rows = await screen.findAllByRole('row');
    const sell = rows.find((row) => row.textContent?.includes('sold early'))!;
    expect(within(sell).getByText('sell')).toBeInTheDocument();
    expect(within(sell).getByText('+9.4%')).toBeInTheDocument();
    expect(within(sell).getByText('—')).toBeInTheDocument(); // 20-bar horizon not reached
  });

  it('marks passes distinctly', async () => {
    renderWithProviders(<DecisionsTable roundId={1} />);

    const rows = await screen.findAllByRole('row');
    const pass = rows.find((row) => row.textContent?.includes('passing avoided'))!;
    expect(within(pass).getByText('pass')).toBeInTheDocument();
  });

  it('filters to a single decision type', async () => {
    renderWithProviders(<DecisionsTable roundId={1} />);
    await screen.findAllByRole('row');

    await userEvent.selectOptions(screen.getByLabelText(/show/i), 'pass');

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('pass');
  });

  it('shows an empty state', async () => {
    server.use(http.get('/api/analytics/rounds/:id/decisions', () => HttpResponse.json([])));
    renderWithProviders(<DecisionsTable roundId={1} />);

    expect(await screen.findByText(/no decisions to score/i)).toBeInTheDocument();
  });
});

describe('check-in ledger', () => {
  it('shows tokens, actions and the linked reasoning', () => {
    renderWithProviders(<CheckinLedger checkins={roundAnalyticsFixture.checkins} />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('1,800');
    expect(rows[0]).toHaveTextContent('place_order, write_journal');
    expect(rows[0]).toHaveTextContent('Took profit into strength.');
  });

  it('totals token spend', () => {
    renderWithProviders(<CheckinLedger checkins={roundAnalyticsFixture.checkins} />);
    expect(screen.getByText(/3,000 tokens across 2 check-ins/i)).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderWithProviders(<CheckinLedger checkins={[]} />);
    expect(screen.getByText(/no check-ins yet/i)).toBeInTheDocument();
  });
});
