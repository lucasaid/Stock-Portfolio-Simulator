import { Link } from 'react-router-dom';
import { latestEquityCents, useEquity, useRound, useRounds } from '../api/hooks';
import type { RoundListItem } from '../api/types';
import { Sparkline } from '../components/charts/Sparkline';
import { ErrorBox } from '../components/ErrorBox';
import { Money } from '../components/Money';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { formatCents } from '../lib/format';

function GoalProgress({ pocketed, goal }: { pocketed: number; goal: number }) {
  const pct = goal <= 0 ? 0 : Math.min(100, (pocketed / goal) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pocketed}
      aria-valuemin={0}
      aria-valuemax={goal}
      aria-label={`${formatCents(pocketed)} of ${formatCents(goal)} pocketed`}
      style={{ background: 'var(--border)', borderRadius: 999, height: 8, overflow: 'hidden' }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gain)' }} />
    </div>
  );
}

function RoundCard({ round }: { round: RoundListItem }) {
  // Badges live in config, which the list endpoint does not return; the detail
  // query is already cached by the time a user clicks through.
  const detail = useRound(round.id);
  const equity = useEquity(round.id);
  const points = [...(equity.data ?? [])]
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    .map((p) => p.equity_cents / 100);
  // Portfolio value = cash + mark-to-market holdings (latest equity snapshot) + pocketed
  // profit (already skimmed out of cash, so it has to be added back in).
  const portfolioValueCents = (latestEquityCents(equity.data ?? []) ?? round.cash_cents) + round.totalSkimsCents;

  return (
    <article className="panel grid" style={{ gap: '0.6rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
          <Link to={`/rounds/${round.id}`} style={{ color: 'inherit' }}>
            {round.name}
          </Link>
        </h2>
        <StatusBadge status={round.status} />
      </div>

      <Sparkline values={points} />

      <dl className="row" style={{ justifyContent: 'space-between', margin: 0 }}>
        <div>
          <dt className="muted">Portfolio value</dt>
          <dd data-testid="portfolio-value" style={{ margin: 0 }}>
            <Money cents={portfolioValueCents} />
          </dd>
        </div>
        <div>
          <dt className="muted">Pocketed</dt>
          <dd style={{ margin: 0 }}>
            <Money cents={round.totalSkimsCents} />
          </dd>
        </div>
        <div>
          <dt className="muted">Cash</dt>
          <dd style={{ margin: 0 }}>
            <Money cents={round.cash_cents} />
          </dd>
        </div>
        <div>
          <dt className="muted">Bankroll</dt>
          <dd style={{ margin: 0 }}>
            <Money cents={round.starting_balance_cents} />
          </dd>
        </div>
      </dl>

      <GoalProgress pocketed={round.totalSkimsCents} goal={round.profit_goal_cents} />

      {detail.data && (
        <div className="row muted" style={{ fontSize: '0.85em' }}>
          <span>{detail.data.config.riskProfile}</span>
          <span>{detail.data.config.tradingStyle}</span>
          <span>{detail.data.config.markets.join(' + ')}</span>
          <span>{detail.data.config.model}</span>
        </div>
      )}
    </article>
  );
}

export function RoundsPage() {
  const rounds = useRounds();

  return (
    <section className="grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Rounds</h1>
        <Link to="/rounds/new">
          <button className="primary">New round</button>
        </Link>
      </div>

      {rounds.isPending && <Spinner label="Loading rounds" />}
      <ErrorBox error={rounds.error} />

      {rounds.data?.length === 0 && <p className="muted">No rounds yet. Start one to put the bankroll to work.</p>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {rounds.data?.map((round) => (
          <RoundCard key={round.id} round={round} />
        ))}
      </div>
    </section>
  );
}
