import type { LedgerRow } from '../../api/types';
import { Money } from '../../components/Money';
import { formatTs } from '../../lib/format';

export function LedgerTable({ ledger }: { ledger: LedgerRow[] }) {
  if (ledger.length === 0) return <p className="muted">No ledger entries yet.</p>;
  const rows = [...ledger].sort((a, b) => b.id - a.id);

  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Type</th>
          <th className="num">Amount</th>
          <th className="num">Balance after</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{formatTs(row.created_at)}</td>
            <td>{row.type}</td>
            <td className="num">
              <Money cents={row.amount_cents} signed />
            </td>
            <td className="num">
              <Money cents={row.balance_after_cents} />
            </td>
            <td className="muted">{row.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
