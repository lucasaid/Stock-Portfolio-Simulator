import { useState } from 'react';
import { useKillSwitch } from '../api/hooks';

/** Spec §5: the kill switch pauses every active round. Protective stops keep running. */
export function KillSwitch() {
  const [confirming, setConfirming] = useState(false);
  const kill = useKillSwitch();

  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} title="Pause every active round">
        Kill switch
      </button>
    );
  }

  return (
    <span className="row">
      <button
        className="primary"
        onClick={() => {
          kill.mutate(undefined, { onSettled: () => setConfirming(false) });
        }}
        disabled={kill.isPending}
      >
        Pause all rounds
      </button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}
