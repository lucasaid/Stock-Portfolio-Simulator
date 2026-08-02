import { useState } from 'react';
import { useDecisions, type DecisionOutcome } from '../../api/analytics';
import { ErrorBox } from '../../components/ErrorBox';
import { Spinner } from '../../components/Spinner';
import { formatTs } from '../../lib/format';

const FILTERS = ['all', 'buy', 'sell', 'pass'] as const;
type Filter = (typeof FILTERS)[number];

function pct(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/** Green when the decision looks vindicated at the medium horizon, red when not. */
function toneFor(outcome: DecisionOutcome): string | undefined {
  const medium = outcome.forward.find((f) => f.bars === 5)?.pricePct ?? null;
  if (medium === null) return undefined;
  if (outcome.decision === 'buy') return medium >= 0 ? 'gain' : 'loss';
  // Selling before a rise, or passing on one, is the regret case.
  if (outcome.decision === 'sell') return medium > 2 ? 'loss' : 'gain';
  return medium > 2 ? 'loss' : 'gain';
}

export function DecisionsTable({ roundId }: { roundId: number }) {
  const decisions = useDecisions(roundId);
  const [filter, setFilter] = useState<Filter>('all');

  if (decisions.isPending) return <Spinner label="Scoring decisions" />;
  if (decisions.error) return <ErrorBox error={decisions.error} />;

  const all = decisions.data ?? [];
  const rows = all.filter((row) => filter === 'all' || row.decision === filter);
  const horizons = all[0]?.forward.map((f) => f.bars) ?? [1, 5, 20];

  return (
    <div className="grid" style={{ gap: '0.4rem' }}>
      <label className="row">
        Show
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      {all.length === 0 ? (
        <p className="muted">No decisions to score yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Decision</th>
              <th>Symbol</th>
              {horizons.map((bars) => (
                <th key={bars} className="num">
                  +{bars} bar{bars === 1 ? '' : 's'}
                </th>
              ))}
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.at}-${row.decision}-${row.symbol}`}>
                <td>{formatTs(row.at)}</td>
                <td>{row.decision}</td>
                <td>{row.symbol}</td>
                {row.forward.map((forward) => (
                  <td key={forward.bars} className="num">
                    {pct(forward.pricePct)}
                  </td>
                ))}
                <td className={toneFor(row)}>{row.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
