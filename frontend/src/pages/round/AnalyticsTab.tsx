import type { ReactNode } from 'react';
import { useRoundAnalytics } from '../../api/analytics';
import { BenchmarkChart } from '../../components/charts/BenchmarkChart';
import { Histogram } from '../../components/charts/Histogram';
import { Scatter } from '../../components/charts/Scatter';
import { ErrorBox } from '../../components/ErrorBox';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { formatCents } from '../../lib/format';
import { CheckinLedger } from './CheckinLedger';
import { DecisionsTable } from './DecisionsTable';

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId: string }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div className="muted" style={{ fontSize: '0.8em' }}>
        {label}
      </div>
      <div data-testid={testId} style={{ fontSize: '1.1rem' }}>
        {value}
      </div>
    </div>
  );
}

function days(ms: number): string {
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function AnalyticsTab({ roundId }: { roundId: number }) {
  const analytics = useRoundAnalytics(roundId);

  if (analytics.isPending) return <Spinner label="Crunching analytics" />;
  if (analytics.error) return <ErrorBox error={analytics.error} />;
  if (!analytics.data) return null;

  const { stats, histogram, scatter, costs, eras, tokenTotals, checkins } = analytics.data;

  return (
    <div className="grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Stat label="Closed trades" value={stats.closed} testId="stat-closed" />
        <Stat label="Win rate" value={`${stats.winRatePct.toFixed(1)}%`} testId="stat-win-rate" />
        <Stat label="Avg win" value={<Money cents={stats.avgWinCents} />} testId="stat-avg-win" />
        <Stat label="Avg loss" value={<Money cents={stats.avgLossCents} />} testId="stat-avg-loss" />
        <Stat label="Net" value={<Money cents={stats.totalNetCents} signed />} testId="stat-net" />
        <Stat
          label="Profit factor"
          value={stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}
          testId="stat-profit-factor"
        />
        <Stat label="Median hold" value={days(stats.medianHoldMs)} testId="stat-median-hold" />
        <Stat label="Tokens" value={tokenTotals.checkinTokens.toLocaleString('en-AU')} testId="stat-tokens" />
      </div>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Return distribution</h3>
        <Histogram buckets={histogram} />
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Hold time vs return</h3>
        <Scatter points={scatter} />
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Benchmark</h3>
        <BenchmarkChart roundId={roundId} />
      </section>

      <section data-testid="costs">
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Costs</h3>
        <div className="row" style={{ marginBottom: '0.4rem' }}>
          <Stat label="Total fees" value={<span>{formatCents(costs.totalFeesCents)}</span>} testId="fees-total" />
          <Stat label="ASX brokerage" value={<span>{formatCents(costs.asxFeesCents)}</span>} testId="fees-asx" />
          <Stat label="US / FX" value={<span>{formatCents(costs.usFeesCents)}</span>} testId="fees-us" />
        </div>
        {costs.byDay.length === 0 ? (
          <p className="muted">No fees charged yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Fees</th>
              </tr>
            </thead>
            <tbody>
              {costs.byDay.map((row) => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td className="num">
                    <Money cents={row.feesCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="eras">
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Config eras</h3>
        <table>
          <thead>
            <tr>
              <th>Era</th>
              <th className="num">Closed</th>
              <th className="num">Win rate</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {eras.map((era) => (
              <tr key={era.from}>
                <td>{era.label}</td>
                <td className="num">{era.stats.closed}</td>
                <td className="num">{era.stats.winRatePct.toFixed(0)}%</td>
                <td className="num">
                  <Money cents={era.stats.totalNetCents} signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Decision outcomes</h3>
        <DecisionsTable roundId={roundId} />
      </section>

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Check-in ledger</h3>
        <CheckinLedger checkins={checkins} />
      </section>
    </div>
  );
}
