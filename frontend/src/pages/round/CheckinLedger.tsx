import type { CheckinLedgerRow } from '../../api/analytics';
import { formatTs } from '../../lib/format';

/** Spec §6: tokens, actions and the reasoning linked to each check-in. */
export function CheckinLedger({ checkins }: { checkins: CheckinLedgerRow[] }) {
  if (checkins.length === 0) return <p className="muted">No check-ins yet.</p>;

  const totalTokens = checkins.reduce((sum, row) => sum + row.tokensUsed, 0);

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        {totalTokens.toLocaleString('en-AU')} tokens across {checkins.length} check-in
        {checkins.length === 1 ? '' : 's'}
      </p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Status</th>
            <th className="num">Tokens</th>
            <th>Actions</th>
            <th>Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {checkins.map((row) => (
            <tr key={row.id}>
              <td>{formatTs(row.ts)}</td>
              <td className={row.status === 'success' ? undefined : 'loss'}>{row.status}</td>
              <td className="num">{row.tokensUsed.toLocaleString('en-AU')}</td>
              <td>{row.actions.length === 0 ? '—' : row.actions.join(', ')}</td>
              <td className="muted">{row.reasoning.join(' ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
