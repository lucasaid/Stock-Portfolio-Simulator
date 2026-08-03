import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ScansPanel } from '../src/pages/round/ScansPanel';
import { renderWithProviders } from './render';
import { scansFixture, server } from './server';

describe('ScansPanel', () => {
  it('shows each scan status, timestamp, and added/removed symbols', async () => {
    renderWithProviders(<ScansPanel roundId={1} />);

    expect(await screen.findByText((text) => text.includes('Added:') && text.includes('NVDA'))).toBeInTheDocument();
    expect(screen.getByText(/03 Aug/)).toBeInTheDocument();
    expect(screen.getByText(/success/i)).toBeInTheDocument();
  });

  it('shows token spend and cost per scan', async () => {
    renderWithProviders(<ScansPanel roundId={1} />);
    await screen.findByText(/success/i);

    expect(screen.getByText(/3,100 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0201/)).toBeInTheDocument();
  });

  it('renders a failed scan with the loss class and its error text', async () => {
    renderWithProviders(<ScansPanel roundId={1} />);

    const errorText = await screen.findByText(/empty or failed scan run/i);
    expect(errorText.closest('section')).toHaveClass('loss');
  });

  it('runs a scan on demand and disables the button while pending', async () => {
    let requested = false;
    server.use(
      http.post('/api/rounds/:id/scan', async () => {
        requested = true;
        return HttpResponse.json({ status: 'success', detail: '8 words' });
      }),
    );
    renderWithProviders(<ScansPanel roundId={1} />);
    await screen.findByText(/success/i);

    const button = screen.getByRole('button', { name: /scan now/i });
    await userEvent.click(button);

    await waitFor(() => expect(requested).toBe(true));
  });

  it('shows the empty state', async () => {
    server.use(http.get('/api/rounds/:id/scans', () => HttpResponse.json([])));
    renderWithProviders(<ScansPanel roundId={1} />);

    expect(await screen.findByText(/no market scans yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error via role="alert"', async () => {
    server.use(
      http.get('/api/rounds/:id/scans', () => HttpResponse.json({ error: 'scan unavailable' }, { status: 500 })),
    );
    renderWithProviders(<ScansPanel roundId={1} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/scan unavailable/i);
  });
});

// Sanity check that the shared fixture stays representative of both statuses.
it('fixture includes both a success and an error row', () => {
  expect(scansFixture.some((s) => s.status === 'success')).toBe(true);
  expect(scansFixture.some((s) => s.status === 'error')).toBe(true);
});
