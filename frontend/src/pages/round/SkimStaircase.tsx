import type { LedgerRow } from '../../api/types';
import { formatCents, formatTs } from '../../lib/format';

/**
 * Spec §2.3: every skim is money that can no longer be lost. Shown as a
 * cumulative staircase toward the profit goal. Skims are stored as negative
 * ledger amounts (cash leaving the round), so they are negated here.
 */
export function SkimStaircase({ ledger, goalCents }: { ledger: LedgerRow[]; goalCents: number }) {
  const skims = ledger
    .filter((row) => row.type === 'skim')
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  if (skims.length === 0) return <p className="muted">Nothing pocketed yet.</p>;

  let running = 0;
  const steps = skims.map((skim) => {
    running += -skim.amount_cents;
    return { id: skim.id, at: skim.created_at, amount: -skim.amount_cents, cumulative: running };
  });

  return (
    <ol data-testid="skim-staircase" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((step) => (
        <li key={step.id} className="row" style={{ justifyContent: 'space-between', padding: '0.25rem 0' }}>
          <span className="muted">{formatTs(step.at)}</span>
          <span className="gain">+{formatCents(step.amount)}</span>
          <strong>{formatCents(step.cumulative)}</strong>
          <span className="muted">of {formatCents(goalCents)}</span>
        </li>
      ))}
    </ol>
  );
}
