import { useRoundStatus, useRunCheckin } from '../../api/hooks';
import type { RoundStatus } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';

/** Mirrors TRANSITIONS in backend/src/api/rounds-routes.ts. Keep the two in step. */
const TRANSITIONS: { action: string; label: string; from: RoundStatus[] }[] = [
  { action: 'pause', label: 'Pause', from: ['active', 'takeover'] },
  { action: 'resume', label: 'Resume', from: ['paused', 'takeover'] },
  { action: 'takeover', label: 'Take over', from: ['active', 'paused'] },
  { action: 'release', label: 'Release to agent', from: ['takeover'] },
  { action: 'archive', label: 'Archive', from: ['paused', 'goal_reached', 'busted'] },
];

export function Controls({ roundId, status }: { roundId: number; status: RoundStatus }) {
  const transition = useRoundStatus(roundId);
  const checkin = useRunCheckin(roundId);
  const available = TRANSITIONS.filter((t) => t.from.includes(status));

  return (
    <div className="grid" style={{ gap: '0.5rem' }}>
      <div className="row">
        {available.map((t) => (
          <button key={t.action} onClick={() => transition.mutate(t.action)} disabled={transition.isPending}>
            {t.label}
          </button>
        ))}
        <button className="primary" onClick={() => checkin.mutate()} disabled={checkin.isPending}>
          {checkin.isPending ? 'Checking in…' : 'Check in now'}
        </button>
      </div>
      {status === 'takeover' && (
        <p className="muted" style={{ margin: 0 }}>
          Takeover: the agent is advisory only — it can journal and adjust the watchlist, but it cannot trade.
        </p>
      )}
      <ErrorBox error={transition.error ?? checkin.error} />
    </div>
  );
}
