import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { WatchlistField } from '../src/components/WatchlistField';
import { renderWithProviders } from './render';
import { server } from './server';

const candidates = [
  { symbol: 'AAPL' },
  { symbol: 'MSFT' },
  { symbol: 'AMZN' },
  { symbol: 'NVDA' },
  { symbol: 'GOOG' },
  { symbol: 'META' },
];

function Harness({ markets }: { markets: ('ASX' | 'US')[] }) {
  const [value, setValue] = useState('');
  return <WatchlistField value={value} onChange={setValue} markets={markets} />;
}

describe('WatchlistField', () => {
  it('fetches candidates for the selected markets and fills the field with a random subset', async () => {
    let requestedMarkets: string | null = null;
    server.use(
      http.get('/api/market/candidates', ({ request }) => {
        requestedMarkets = new URL(request.url).searchParams.get('markets');
        return HttpResponse.json(candidates);
      }),
    );
    renderWithProviders(<Harness markets={['US']} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Shuffle' }));

    await waitFor(() => {
      const input = screen.getByRole('textbox') as HTMLInputElement;
      expect(input.value).not.toBe('');
    });
    expect(requestedMarkets).toBe('US');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    const picked = input.value.split(',').map((s) => s.trim()).filter((s) => s !== '');
    expect(picked.length).toBeGreaterThan(0);
    for (const symbol of picked) {
      expect(candidates.map((c) => c.symbol)).toContain(symbol);
    }
  });

  it('is disabled when no market is selected', async () => {
    renderWithProviders(<Harness markets={[]} />);
    expect(await screen.findByRole('button', { name: 'Shuffle' })).toBeDisabled();
  });

  it('shows a message rather than silently doing nothing when the pool is empty', async () => {
    server.use(http.get('/api/market/candidates', () => HttpResponse.json([])));
    renderWithProviders(<Harness markets={['ASX']} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Shuffle' }));

    expect(await screen.findByText(/No active symbols found/)).toBeInTheDocument();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('shows an error if the candidate fetch fails', async () => {
    server.use(http.get('/api/market/candidates', () => HttpResponse.json({ error: 'boom' }, { status: 502 })));
    renderWithProviders(<Harness markets={['US']} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Shuffle' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
