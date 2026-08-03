import { useReplaySweep } from '../../api/analytics';
import { ErrorBox } from '../../components/ErrorBox';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';

export function ReplayPanel({ roundId }: { roundId: number }) {
  const sweep = useReplaySweep(roundId);

  if (sweep.isPending) return <Spinner label="Replaying guardrail sweep" />;
  if (sweep.error) return <ErrorBox error={sweep.error} />;

  const rows = sweep.data ?? [];
  const insufficient = rows.length > 0 && rows.every((row) => row.result.insufficientHistory);

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <p className="muted">
        Trades are held fixed — this replays the same buys and sells against the same price
        history under different guardrail settings. It cannot tell you how the agent would have
        behaved with different rules.
      </p>

      {insufficient ? (
        <p className="muted">Not enough price history to replay this round yet.</p>
      ) : rows.length === 0 ? (
        <p className="muted">No sweep results yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Stop-loss</th>
              <th className="num">Pocketed</th>
              <th className="num">Fees</th>
              <th className="num">Final cash</th>
              <th className="num">Stops fired</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>
                  {row.label}
                  {row.actual && <span data-testid="actual-badge"> (actual)</span>}
                </td>
                <td className="num">
                  <Money cents={row.result.skimmedCents} />
                </td>
                <td className="num">
                  <Money cents={row.result.feesCents} />
                </td>
                <td className="num">
                  <Money cents={row.result.finalCashCents} />
                </td>
                <td className="num">{row.result.stopLossFirings.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
