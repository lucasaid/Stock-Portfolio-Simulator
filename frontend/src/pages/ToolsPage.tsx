import { useState } from 'react';
import { useOptimizerRuns, useRunOptimizer } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';
import { Markdown } from '../components/Markdown';
import { Spinner } from '../components/Spinner';
import { formatTs } from '../lib/format';

export function ToolsPage() {
  const [webSearch, setWebSearch] = useState(false);
  const runs = useOptimizerRuns();
  const runOptimizer = useRunOptimizer();

  if (runs.isPending) return <Spinner label="Loading tools" />;
  if (runs.error) return <ErrorBox error={runs.error} />;

  const rows = runs.data ?? [];

  return (
    <section className="grid">
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Tools</h1>

      <div className="panel grid" style={{ gap: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Agent optimizer</h2>
        <p className="muted" style={{ margin: 0 }}>
          Reads recent check-ins, research, and market scans across every round, looks for
          repeatable patterns, and writes a prompt you can hand to a Claude Code session to
          implement the change. It never edits the codebase itself.
        </p>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="row" htmlFor="tools-web-search">
            <input
              id="tools-web-search"
              type="checkbox"
              checked={webSearch}
              onChange={(e) => setWebSearch(e.target.checked)}
            />
            Enable web search for this run
          </label>
          <button onClick={() => runOptimizer.mutate({ webSearch })} disabled={runOptimizer.isPending}>
            {runOptimizer.isPending ? 'Running…' : 'Run optimizer'}
          </button>
        </div>
        <ErrorBox error={runOptimizer.error} />

        {rows.length === 0 ? (
          <p className="muted">No optimizer runs yet.</p>
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
                  {row.web_search_enabled ? 'web search on' : 'web search off'} ·{' '}
                  {row.tokens_used.toLocaleString('en-AU')} tokens · ${row.cost_usd.toFixed(4)}
                </span>
              </div>
              <div style={{ margin: '0.3rem 0 0' }}>
                {row.status === 'error' ? <p>{row.detail}</p> : <Markdown text={row.output} />}
              </div>
            </section>
          ))
        )}
      </div>
    </section>
  );
}
