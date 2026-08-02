import { useEvents } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { formatTs } from '../lib/format';

const LEVEL_CLASS: Record<string, string> = { info: 'muted', warn: 'loss', error: 'loss' };

export function EventFeed({ roundId, limit = 40 }: { roundId?: number; limit?: number }) {
  const events = useEvents(roundId);

  if (events.isPending) return <Spinner label="Loading events" />;
  if (events.error) return <ErrorBox error={events.error} />;

  const rows = [...(events.data ?? [])].sort((a, b) => b.id - a.id).slice(0, limit);
  if (rows.length === 0) return <p className="muted">No events yet.</p>;

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((event) => (
        <li key={event.id} style={{ padding: '0.3rem 0', borderBottom: '1px solid var(--border)' }}>
          <span className="muted" style={{ marginRight: '0.5rem' }}>
            {formatTs(event.created_at)}
          </span>
          <span className={LEVEL_CLASS[event.level]} style={{ marginRight: '0.5rem' }}>
            {event.kind}
          </span>
          {event.message}
        </li>
      ))}
    </ul>
  );
}
