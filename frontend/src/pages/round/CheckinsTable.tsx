import type { CheckinRow } from '../../api/types';
import { formatTs } from '../../lib/format';

function actionSummary(json: string): string {
  try {
    const actions = JSON.parse(json) as { tool?: string }[];
    const tools = Array.isArray(actions)
      ? actions.map((a) => a.tool).filter((t): t is string => typeof t === 'string')
      : [];
    return tools.length === 0 ? '—' : tools.join(', ');
  } catch {
    return '—';
  }
}

export function CheckinsTable({ checkins }: { checkins: CheckinRow[] }) {
  if (checkins.length === 0) return <p className="muted">No check-ins yet.</p>;
  const rows = [...checkins].sort((a, b) => b.id - a.id);

  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Status</th>
          <th>Actions</th>
          <th className="num">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((checkin) => (
          <tr key={checkin.id}>
            <td>{formatTs(checkin.ts)}</td>
            <td className={checkin.status === 'success' ? undefined : 'loss'}>{checkin.status}</td>
            <td>{actionSummary(checkin.actions_json)}</td>
            <td className="num">{checkin.tokens_used?.toLocaleString('en-AU') ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
