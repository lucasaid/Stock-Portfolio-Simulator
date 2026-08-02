import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { qk, useKillSwitch, usePatchConfig, usePlaceOrder, useRunCheckin } from '../src/api/hooks';
import { makeClient } from './render';
import { server } from './server';

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** The set of query keys a mutation marked stale, as comparable strings. */
async function keysInvalidatedBy(run: (client: QueryClient) => Promise<unknown>): Promise<string[]> {
  const client = makeClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  await run(client);
  return spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
}

describe('mutation cache invalidation', () => {
  it('a manual order refreshes everything the money path touched', async () => {
    server.use(
      http.post('/api/rounds/:id/orders', () =>
        HttpResponse.json({ status: 'filled', reason: null, skimCents: 0 }, { status: 201 }),
      ),
    );

    const keys = await keysInvalidatedBy(async (client) => {
      const { result } = renderHook(() => usePlaceOrder(1), { wrapper: wrapper(client) });
      result.current.mutate({ symbol: 'AAPL', side: 'buy', amountCents: 1000 });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    for (const key of [qk.round(1), qk.trades(1), qk.ledger(1), qk.equity(1), qk.rounds]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });

  it('a check-in refreshes equity and the overview, not just the journal', async () => {
    server.use(http.post('/api/rounds/:id/checkin', () => HttpResponse.json({ status: 'success' })));

    const keys = await keysInvalidatedBy(async (client) => {
      const { result } = renderHook(() => useRunCheckin(1), { wrapper: wrapper(client) });
      result.current.mutate();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    // A check-in can trade, so cash and equity move too.
    for (const key of [qk.round(1), qk.checkins(1), qk.journal(1), qk.trades(1), qk.ledger(1), qk.equity(1), qk.rounds]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });

  it('the kill switch refreshes every open round detail', async () => {
    const keys = await keysInvalidatedBy(async (client) => {
      const { result } = renderHook(() => useKillSwitch(), { wrapper: wrapper(client) });
      result.current.mutate();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    // The kill_switch event carries no round_id, so SSE cannot target the detail.
    expect(keys).toContain(JSON.stringify(qk.allRounds));
    expect(keys).toContain(JSON.stringify(qk.rounds));
  });

  it('a config patch refreshes the overview so a rename shows there', async () => {
    server.use(http.patch('/api/rounds/:id/config', () => HttpResponse.json({ changed: 1 })));

    const keys = await keysInvalidatedBy(async (client) => {
      const { result } = renderHook(() => usePatchConfig(1), { wrapper: wrapper(client) });
      result.current.mutate({ name: 'renamed' });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(keys).toContain(JSON.stringify(qk.round(1)));
    expect(keys).toContain(JSON.stringify(qk.rounds));
  });

  it('the allRounds prefix key matches an individual round query', () => {
    // Prefix matching is what makes the kill-switch invalidation work at all.
    expect(qk.round(7).slice(0, qk.allRounds.length)).toEqual([...qk.allRounds]);
  });
});
