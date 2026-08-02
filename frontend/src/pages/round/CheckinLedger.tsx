import type { CheckinLedgerRow } from '../../api/analytics';

// Placeholder — filled in by Plan 5 Task 7.
export function CheckinLedger({ checkins }: { checkins: CheckinLedgerRow[] }) {
  return <p className="muted">{checkins.length} check-ins</p>;
}
