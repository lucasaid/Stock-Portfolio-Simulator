import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ReplayPanel } from '../src/pages/round/ReplayPanel';
import { renderWithProviders } from './render';
import { replaySweepFixture, server } from './server';

describe('ReplayPanel', () => {
  it('renders one row per swept stop-loss setting, including the no-stop row', async () => {
    renderWithProviders(<ReplayPanel roundId={1} />);

    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(replaySweepFixture.length + 1); // + header row
    expect(screen.getByText('no stop-loss')).toBeInTheDocument();
  });

  it("marks the round's actual setting distinctly", async () => {
    renderWithProviders(<ReplayPanel roundId={1} />);

    const rows = await screen.findAllByRole('row');
    const actualRow = rows.find((row) => row.textContent?.includes('10% stop-loss'))!;
    expect(within(actualRow).getByTestId('actual-badge')).toBeInTheDocument();

    const otherRow = rows.find((row) => row.textContent?.includes('5% stop-loss'))!;
    expect(within(otherRow).queryByTestId('actual-badge')).not.toBeInTheDocument();
  });

  it('shows pocketed, fees and final cash per row as formatted money', async () => {
    renderWithProviders(<ReplayPanel roundId={1} />);

    const rows = await screen.findAllByRole('row');
    const noStopRow = rows.find((row) => row.textContent?.includes('no stop-loss'))!;
    expect(within(noStopRow).getByText('$5.00')).toBeInTheDocument(); // pocketed
    expect(within(noStopRow).getByText('$0.30')).toBeInTheDocument(); // fees
    expect(within(noStopRow).getByText('$50.00')).toBeInTheDocument(); // final cash
  });

  it('states plainly that the replay holds the agent trades fixed', async () => {
    renderWithProviders(<ReplayPanel roundId={1} />);
    await screen.findAllByRole('row');

    expect(screen.getByText(/trades are held fixed/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot tell you how the agent would have behaved/i)).toBeInTheDocument();
  });

  it('renders the insufficient-history state', async () => {
    server.use(
      http.get('/api/replay/rounds/:id/sweep', () =>
        HttpResponse.json(
          replaySweepFixture.map((entry) => ({ ...entry, result: { ...entry.result, insufficientHistory: true } })),
        ),
      ),
    );
    renderWithProviders(<ReplayPanel roundId={1} />);

    expect(await screen.findByText(/not enough price history/i)).toBeInTheDocument();
  });

  it('surfaces a load error via role="alert"', async () => {
    server.use(
      http.get('/api/replay/rounds/:id/sweep', () => HttpResponse.json({ error: 'replay failed' }, { status: 500 })),
    );
    renderWithProviders(<ReplayPanel roundId={1} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/replay failed/i);
  });
});
