import { useRunScan, useScans } from '../../api/hooks';
import { ErrorBox } from '../../components/ErrorBox';
import { Spinner } from '../../components/Spinner';
import { formatTs } from '../../lib/format';

export function ScansPanel({ roundId }: { roundId: number }) {
  const scans = useScans(roundId);
  const scan = useRunScan(roundId);

  if (scans.isPending) return <Spinner label="Loading scans" />;
  if (scans.error) return <ErrorBox error={scans.error} />;

  const rows = scans.data ?? [];

  return (
    <div className="grid" style={{ gap: '0.5rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>
          A separate, web-enabled agent run reads the market and proposes watchlist changes. It
          cannot place trades — every symbol it picks is validated against a live quote first.
        </p>
        <button onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? 'Scanning…' : 'Scan now'}
        </button>
      </div>
      <ErrorBox error={scan.error} />

      {rows.length === 0 ? (
        <p className="muted">No market scans yet.</p>
      ) : (
        rows.map((row) => {
          const added = JSON.parse(row.added_json) as string[];
          const removed = JSON.parse(row.removed_json) as string[];
          return (
            <section
              key={row.id}
              className={row.status === 'error' ? 'loss' : undefined}
              style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{formatTs(row.created_at)}</strong>
                <span className="muted" style={{ fontSize: '0.85em' }}>
                  {row.status} · {row.tokens_used.toLocaleString('en-AU')} tokens · $
                  {row.cost_usd.toFixed(4)}
                </span>
              </div>
              <p style={{ margin: '0.3rem 0 0' }}>
                Added: {added.length > 0 ? added.join(', ') : 'none'} · Removed:{' '}
                {removed.length > 0 ? removed.join(', ') : 'none'}
              </p>
              {row.status === 'error' && <p style={{ margin: '0.3rem 0 0' }}>{row.detail}</p>}
            </section>
          );
        })
      )}
    </div>
  );
}
