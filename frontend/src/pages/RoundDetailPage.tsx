import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useCheckins, useEquity, useJournal, useLedger, useRound, useSummaries, useTrades,
} from '../api/hooks';
import { EquityChart } from '../components/charts/EquityChart';
import { ErrorBox } from '../components/ErrorBox';
import { Money } from '../components/Money';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { EventFeed } from '../events/EventFeed';
import { useEventStream } from '../events/useEventStream';
import { AnalyticsTab } from './round/AnalyticsTab';
import { CheckinsTable } from './round/CheckinsTable';
import { ConfigPanel } from './round/ConfigPanel';
import { Controls } from './round/Controls';
import { OrderForm } from './round/OrderForm';
import { JournalList } from './round/JournalList';
import { LedgerTable } from './round/LedgerTable';
import { PositionsTable } from './round/PositionsTable';
import { SkimStaircase } from './round/SkimStaircase';
import { SummariesList } from './round/SummariesList';
import { TradesTable } from './round/TradesTable';

const TABS = ['positions', 'trades', 'ledger', 'journal', 'checkins', 'summaries', 'analytics', 'settings', 'events'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Partial<Record<Tab, string>> = { checkins: 'check-ins' };

function Stat({ label, cents, testId }: { label: string; cents: number; testId: string }) {
  return (
    <div>
      <div className="muted">{label}</div>
      <div data-testid={testId} style={{ fontSize: '1.2rem' }}>
        <Money cents={cents} />
      </div>
    </div>
  );
}

export function RoundDetailPage({ roundId: propId }: { roundId?: number } = {}) {
  const params = useParams();
  const roundId = propId ?? Number(params.id);
  const [tab, setTab] = useState<Tab>('positions');

  useEventStream(roundId);
  const detail = useRound(roundId);
  const equity = useEquity(roundId);
  const trades = useTrades(roundId);
  const ledger = useLedger(roundId);
  const journal = useJournal(roundId);
  const checkins = useCheckins(roundId);
  const summaries = useSummaries(roundId);

  if (detail.isPending) return <Spinner label="Loading round" />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return null;

  const { round, config, positions, totalSkimsCents } = detail.data;

  return (
    <section className="grid">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>{round.name}</h1>
        <StatusBadge status={round.status} />
      </div>

      <div className="panel row" style={{ justifyContent: 'space-between' }}>
        <Stat label="Cash" cents={round.cash_cents} testId="cash" />
        <Stat label="Pocketed" cents={totalSkimsCents} testId="pocketed" />
        <Stat label="Bankroll" cents={round.starting_balance_cents} testId="bankroll" />
        <Stat label="Goal" cents={round.profit_goal_cents} testId="goal" />
      </div>

      <div className="panel">
        <Controls roundId={roundId} status={round.status} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Equity</h2>
        <EquityChart points={equity.data ?? []} trades={trades.data ?? []} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Pocketed profit</h2>
        <SkimStaircase ledger={ledger.data ?? []} goalCents={round.profit_goal_cents} />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Manual order</h2>
        <OrderForm roundId={roundId} status={round.status} positions={positions} watchlist={config.watchlist} />
      </div>

      <div className="row" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            id={`tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            onClick={() => setTab(name)}
            className={tab === name ? 'primary' : undefined}
          >
            {TAB_LABELS[name] ?? name}
          </button>
        ))}
      </div>

      <div className="panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'positions' && <PositionsTable positions={positions} />}
        {tab === 'trades' && <TradesTable trades={trades.data ?? []} />}
        {tab === 'ledger' && <LedgerTable ledger={ledger.data ?? []} />}
        {tab === 'journal' && <JournalList entries={journal.data ?? []} />}
        {tab === 'checkins' && <CheckinsTable checkins={checkins.data ?? []} />}
        {tab === 'summaries' && <SummariesList summaries={summaries.data ?? []} />}
        {tab === 'analytics' && <AnalyticsTab roundId={roundId} />}
        {tab === 'settings' && <ConfigPanel roundId={roundId} config={config} />}
        {tab === 'events' && <EventFeed roundId={roundId} />}
      </div>

      <p className="muted" style={{ fontSize: '0.85em' }}>
        {config.riskProfile} · {config.tradingStyle} · {config.markets.join(' + ')} · {config.model}
      </p>
    </section>
  );
}
