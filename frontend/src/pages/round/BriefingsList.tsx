import { useBriefings, useRunResearch } from '../../api/hooks';
import { ErrorBox } from '../../components/ErrorBox';
import { Markdown } from '../../components/Markdown';
import { Spinner } from '../../components/Spinner';
import { formatTs } from '../../lib/format';

export function BriefingsList({ roundId }: { roundId: number }) {
  const briefings = useBriefings(roundId);
  const research = useRunResearch(roundId);

  if (briefings.isPending) return <Spinner label="Loading briefings" />;
  if (briefings.error) return <ErrorBox error={briefings.error} />;

  const rows = briefings.data ?? [];

  return (
    <div className="grid" style={{ gap: '0.5rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>
          A separate, web-enabled agent run gathers news and sentiment for this round's symbols.
          It cannot place trades.
        </p>
        <button onClick={() => research.mutate()} disabled={research.isPending}>
          {research.isPending ? 'Researching…' : 'Research now'}
        </button>
      </div>
      <ErrorBox error={research.error} />

      {rows.length === 0 ? (
        <p className="muted">No research briefings yet.</p>
      ) : (
        rows.map((row) => (
          <section
            key={row.id}
            className={row.status === 'error' ? 'loss' : undefined}
            style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{formatTs(row.created_at)}</strong>
              <span className="muted" style={{ fontSize: '0.85em' }}>
                {row.tokens_used.toLocaleString('en-AU')} tokens · ${row.cost_usd.toFixed(4)}
              </span>
            </div>
            <div style={{ margin: '0.3rem 0 0' }}>
              <Markdown text={row.briefing} />
            </div>
          </section>
        ))
      )}
    </div>
  );
}
