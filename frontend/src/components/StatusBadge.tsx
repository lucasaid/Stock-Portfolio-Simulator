import type { RoundStatus } from '../api/types';

const LABELS: Record<RoundStatus, string> = {
  active: 'active',
  paused: 'paused',
  takeover: 'takeover',
  goal_reached: 'goal reached',
  busted: 'busted',
  archived: 'archived',
};

const COLORS: Record<RoundStatus, string> = {
  active: 'var(--gain)',
  paused: 'var(--muted)',
  takeover: 'var(--accent)',
  goal_reached: 'var(--gain)',
  busted: 'var(--loss)',
  archived: 'var(--muted)',
};

export function StatusBadge({ status }: { status: RoundStatus }) {
  return (
    <span
      style={{
        border: `1px solid ${COLORS[status]}`,
        color: COLORS[status],
        borderRadius: 999,
        padding: '0.1rem 0.55rem',
        fontSize: '0.8em',
      }}
    >
      {LABELS[status]}
    </span>
  );
}
