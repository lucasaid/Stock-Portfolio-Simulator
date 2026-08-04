import type { ReactNode } from 'react';
import type { AiUsageByType } from '../../api/analytics';
import { useRoundAnalytics } from '../../api/analytics';
import { BenchmarkChart } from '../../components/charts/BenchmarkChart';
import { Histogram } from '../../components/charts/Histogram';
import { Scatter } from '../../components/charts/Scatter';
import { Sparkline } from '../../components/charts/Sparkline';
import { ErrorBox } from '../../components/ErrorBox';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { formatCents } from '../../lib/format';
import { CheckinLedger } from './CheckinLedger';
import { DecisionsTable } from './DecisionsTable';
import { ReplayPanel } from './ReplayPanel';

const TYPE_LABELS: Record<AiUsageByType['type'], string> = {
  checkin: 'Check-ins',
  research: 'Research',
  scan: 'Scans',
};

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

  const { stats, histogram, scatter, costs, eras, tokenTotals, checkins, aiUsage } = analytics.data;

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

      <section data-testid="ai-usage">
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>AI usage</h3>
        <table>
          <thead>
            <tr>
              <th></th>
              <th className="num">Runs</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {aiUsage.byType.map((t) => (
              <tr key={t.type}>
                <td>{TYPE_LABELS[t.type]}</td>
                <td className="num">{t.runs}</td>
                <td className="num">{t.tokens.toLocaleString('en-AU')}</td>
                <td className="num">${t.costUsd.toFixed(4)}</td>
              </tr>
            ))}
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td className="num" />
              <td className="num">
                <strong>{aiUsage.totalTokens.toLocaleString('en-AU')}</strong>
              </td>
              <td className="num">
                <strong>${aiUsage.totalCostUsd.toFixed(4)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <Sparkline values={aiUsage.byDay.map((d) => d.costUsd)} />
        <div>
          <h4 style={{ fontSize: '0.9rem', margin: '0.5rem 0 0.3rem' }}>Repeated check-in patterns</h4>
          <ul>
            {aiUsage.patterns.map((p, i) => (
              <li key={i}>
                {p.sequence.length === 0 ? '(no action taken)' : p.sequence.join(' → ')} — ×{p.count}
              </li>
            ))}
          </ul>
        </div>
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

      <section>
        <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>What if the guardrails had been different?</h3>
        <ReplayPanel roundId={roundId} />
      </section>
    </div>
  );
}
