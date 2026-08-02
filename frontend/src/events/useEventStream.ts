import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { qk } from '../api/hooks';
import type { EventRow } from '../api/types';

/** Which round-scoped query keys each event kind makes stale. */
function staleKeys(kind: string, roundId: number): readonly (readonly unknown[])[] {
  switch (kind) {
    case 'trade':
    case 'order_rejected':
    case 'stop_loss':
      return [qk.trades(roundId), qk.ledger(roundId), qk.round(roundId), qk.equity(roundId), qk.rounds];
    case 'skim':
      return [qk.ledger(roundId), qk.round(roundId), qk.rounds];
    case 'round_status':
    case 'round_created':
    case 'kill_switch':
      return [qk.round(roundId), qk.rounds];
    case 'config_change':
      return [qk.round(roundId)];
    case 'checkin_complete':
    case 'checkin_failed':
    case 'checkin_interrupted':
      return [qk.checkins(roundId), qk.journal(roundId), qk.round(roundId)];
    case 'daily_summary':
      return [qk.summaries(roundId)];
    default:
      return [];
  }
}

/**
 * Subscribes to the server event stream and invalidates the queries each event
 * touches. Events are notifications, never data — the UI always refetches.
 */
export function useEventStream(roundId?: number): void {
  const client = useQueryClient();

  useEffect(() => {
    const url = roundId === undefined ? '/api/events/stream' : `/api/events/stream?roundId=${roundId}`;
    const source = new EventSource(url);

    source.onmessage = (message: MessageEvent) => {
      let event: EventRow;
      try {
        event = JSON.parse(String(message.data)) as EventRow;
      } catch {
        return; // a truncated frame is not worth tearing the stream down over
      }
      void client.invalidateQueries({ queryKey: qk.events(roundId) });
      if (event.round_id === null) return;
      for (const key of staleKeys(event.kind, event.round_id)) {
        void client.invalidateQueries({ queryKey: key });
      }
    };

    // The browser reconnects automatically (the server sends `retry: 5000`).
    return () => source.close();
  }, [client, roundId]);
}
