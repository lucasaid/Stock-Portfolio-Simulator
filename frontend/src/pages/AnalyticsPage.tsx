import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAnalyticsSummary } from '../api/analytics';
import { ComparisonChart } from '../components/charts/ComparisonChart';
import { Sparkline } from '../components/charts/Sparkline';
import { ErrorBox } from '../components/ErrorBox';
import { Money } from '../components/Money';
import { Spinner } from '../components/Spinner';

export function AnalyticsPage() {
  const summary = useAnalyticsSummary();
  const [selected, setSelected] = useState<number[] | null>(null);

  // Default to every round the first time the summary lands.
  useEffect(() => {
    if (selected === null && summary.data) setSelected(summary.data.rounds.map((round) => round.id));
  }, [summary.data, selected]);

  if (summary.isPending) return <Spinner label="Loading analytics" />;
  if (summary.error) return <ErrorBox error={summary.error} />;
  if (!summary.data) return null;

  const { rounds, totals, aiUsageTotals } = summary.data;
  const chosen = selected ?? rounds.map((round) => round.id);

  if (rounds.length === 0) return <p className="muted">No rounds to analyse yet.</p>;

  return (
    <section className="grid">
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Analytics</h1>

      <div className="panel row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>
            Closed trades
          </div>
          <div data-testid="total-closed" style={{ fontSize: '1.2rem' }}>
            {totals.closed}
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>
            Win rate
          </div>
          <div data-testid="total-win-rate" style={{ fontSize: '1.2rem' }}>
            {totals.winRatePct.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>
            Net
          </div>
          <div data-testid="total-net" style={{ fontSize: '1.2rem' }}>
            <Money cents={totals.totalNetCents} signed />
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>
            Fees
          </div>
          <div data-testid="total-fees" style={{ fontSize: '1.2rem' }}>
            <Money cents={totals.totalFeesCents} />
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.8em' }}>
            AI cost
          </div>
          <div data-testid="total-ai-cost" style={{ fontSize: '1.2rem' }}>
            ${aiUsageTotals.totalCostUsd.toFixed(4)}
          </div>
        </div>
      </div>

      <div className="panel grid">
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Equity comparison (each round indexed to 100)</h2>
        <div className="row">
          {rounds.map((round) => (
            <label key={round.id} className="row">
              <input
                type="checkbox"
                checked={chosen.includes(round.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...chosen, round.id].sort((a, b) => a - b)
                      : chosen.filter((id) => id !== round.id),
                  )
                }
              />
              {round.name}
            </label>
          ))}
        </div>
        <ComparisonChart roundIds={chosen} />
      </div>

      <div className="panel grid">
        <h2 style={{ margin: 0, fontSize: '1rem' }}>AI cost trend (all rounds)</h2>
        <Sparkline values={aiUsageTotals.byDay.map((d) => d.costUsd)} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Per round</h2>
        <table data-testid="round-comparison">
          <thead>
            <tr>
              <th>Round</th>
              <th>Status</th>
              <th className="num">Closed</th>
              <th className="num">Win rate</th>
              <th className="num">Net</th>
              <th className="num">Fees</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round.id}>
                <td>
                  <Link to={`/rounds/${round.id}`}>{round.name}</Link>
                </td>
                <td>{round.status}</td>
                <td className="num">{round.stats.closed}</td>
                <td className="num">{round.stats.winRatePct.toFixed(0)}%</td>
                <td className="num">
                  <Money cents={round.stats.totalNetCents} signed />
                </td>
                <td className="num">
                  <Money cents={round.costs.totalFeesCents} />
                </td>
                <td className="num">{round.tokenTotals.checkinTokens.toLocaleString('en-AU')}</td>
                <td className="num">${round.aiUsage.totalCostUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
