import type { JournalRow } from '../../api/types';
import { Markdown } from '../../components/Markdown';
import { formatTs } from '../../lib/format';

export function JournalList({ entries }: { entries: JournalRow[] }) {
  if (entries.length === 0) return <p className="muted">No journal entries yet.</p>;
  const rows = [...entries].sort((a, b) => b.id - a.id);

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((entry) => (
        <li key={entry.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
          <div className="row muted" style={{ fontSize: '0.85em' }}>
            <span>{formatTs(entry.created_at)}</span>
            <span>{entry.author}</span>
            {entry.checkin_id !== null && <span>check-in #{entry.checkin_id}</span>}
          </div>
          <div style={{ margin: '0.2rem 0 0' }}>
            <Markdown text={entry.note} />
          </div>
        </li>
      ))}
    </ul>
  );
}
