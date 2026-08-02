import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { qk } from '../src/api/hooks';
import { EventFeed } from '../src/events/EventFeed';
import { useEventStream } from '../src/events/useEventStream';
import { makeClient, renderWithProviders } from './render';
import { MockEventSource } from './setup';
import { server } from './server';

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('SSE', () => {
  it('opens the stream once and closes it on unmount', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const { unmount } = renderHook(() => useEventStream(), { wrapper: wrapper(client) });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe('/api/events/stream');

    unmount();
    expect(MockEventSource.instances[0]!.closed).toBe(true);
  });

  it('scopes the stream to a round when given an id', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    renderHook(() => useEventStream(7), { wrapper: wrapper(client) });

    expect(MockEventSource.instances[0]!.url).toBe('/api/events/stream?roundId=7');
  });

  it('invalidates the round queries a trade event touches', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useEventStream(1), { wrapper: wrapper(client) });

    act(() => {
      MockEventSource.instances[0]!.emit({
        id: 12, round_id: 1, level: 'info', kind: 'trade',
        message: 'round 1 buy 2 AAPL', created_at: '2026-08-02T01:00:00.000Z',
      });
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.trades(1)));
    expect(keys).toContain(JSON.stringify(qk.round(1)));
    expect(keys).toContain(JSON.stringify(qk.rounds));
  });

  it('always refreshes the event list itself', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useEventStream(), { wrapper: wrapper(client) });

    act(() => {
      MockEventSource.instances[0]!.emit({
        id: 13, round_id: null, level: 'warn', kind: 'poll_failed',
        message: 'yahoo timeout', created_at: '2026-08-02T01:00:00.000Z',
      });
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.events(undefined)));
  });

  it("refreshes the journal on the backend's actual check-in event kind", () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useEventStream(1), { wrapper: wrapper(client) });

    act(() => {
      // decision.ts logs kind 'checkin' — NOT 'checkin_complete'.
      MockEventSource.instances[0]!.emit({
        id: 20, round_id: 1, level: 'info', kind: 'checkin',
        message: 'round 1 check-in complete: 2 action(s), 1800 tokens', created_at: '2026-08-02T01:00:00.000Z',
      });
    });

    const keys = spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.checkins(1)));
    expect(keys).toContain(JSON.stringify(qk.journal(1)));
    expect(keys).toContain(JSON.stringify(qk.round(1)));
  });

  it('ignores malformed event payloads without throwing', () => {
    MockEventSource.instances.length = 0;
    const client = makeClient();
    renderHook(() => useEventStream(), { wrapper: wrapper(client) });

    expect(() => {
      act(() => {
        MockEventSource.instances[0]!.onmessage?.(new MessageEvent('message', { data: 'not json' }));
      });
    }).not.toThrow();
  });

  it('renders recent events newest first with their level', async () => {
    server.use(
      http.get('/api/events', () =>
        HttpResponse.json([
          { id: 1, round_id: 1, level: 'info', kind: 'trade', message: 'bought AAPL', created_at: '2026-08-02T01:00:00.000Z' },
          { id: 2, round_id: 1, level: 'warn', kind: 'stop_loss', message: 'stop-loss on AAPL', created_at: '2026-08-02T02:00:00.000Z' },
        ]),
      ),
    );
    renderWithProviders(<EventFeed roundId={1} />);

    const items = await screen.findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('stop-loss on AAPL');
    expect(items[1]).toHaveTextContent('bought AAPL');
  });
});
