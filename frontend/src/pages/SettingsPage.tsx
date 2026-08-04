import { useEffect, useState, type ReactNode } from 'react';
import { useChangePassword, useSaveSettings, useSettings } from '../api/hooks';
import type { IntegrationSettings, LookAndFeelSettings, Market, RoundConfig, Settings, UsageGateSettings } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { dollarsToCents } from '../lib/format';
import { applyTheme } from '../shell/useTheme';

type Defaults = Omit<RoundConfig, 'name'>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel grid">
      <h2 style={{ margin: 0, fontSize: '1rem' }}>{title}</h2>
      {children}
    </section>
  );
}

function RoundDefaultsForm({ initial }: { initial: Defaults }) {
  const save = useSaveSettings('roundDefaults');
  const [balance, setBalance] = useState((initial.startingBalanceCents / 100).toFixed(2));
  const [goal, setGoal] = useState((initial.profitGoalCents / 100).toFixed(2));
  const [markets, setMarkets] = useState<Market[]>(initial.markets);
  const [watchlist, setWatchlist] = useState(initial.watchlist.join(', '));
  const [model, setModel] = useState(initial.model);
  const [cron, setCron] = useState(initial.checkinCron.join('\n'));

  const balanceCents = dollarsToCents(balance);
  const goalCents = dollarsToCents(goal);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        if (balanceCents === null || goalCents === null) return;
        save.mutate({
          ...initial,
          startingBalanceCents: balanceCents,
          profitGoalCents: goalCents,
          markets,
          watchlist: watchlist.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s !== ''),
          model,
          checkinCron: cron.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
        });
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        These pre-fill the new-round wizard. Editing them never changes an existing round.
      </p>
      <label>
        Default starting balance ($)
        <input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Default profit goal ($)
        <input value={goal} onChange={(e) => setGoal(e.target.value)} inputMode="decimal" />
      </label>
      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <legend>Default markets</legend>
        {(['ASX', 'US', 'CRYPTO'] as Market[]).map((market) => (
          <label key={market} className="row">
            <input
              type="checkbox"
              checked={markets.includes(market)}
              onChange={(e) => setMarkets(e.target.checked ? [...markets, market] : markets.filter((m) => m !== market))}
            />
            {market}
          </label>
        ))}
      </fieldset>
      <label>
        Default watchlist
        <input value={watchlist} onChange={(e) => setWatchlist(e.target.value)} />
      </label>
      <label>
        Default model
        <input value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        Default check-in schedule
        <textarea rows={3} value={cron} onChange={(e) => setCron(e.target.value)} />
      </label>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save round defaults
      </button>
    </form>
  );
}

function IntegrationsForm({ initial }: { initial: IntegrationSettings }) {
  const save = useSaveSettings('integrations');
  const [url, setUrl] = useState(initial.ntfy.url);
  const [topic, setTopic] = useState(initial.ntfy.topic);
  const [enabled, setEnabled] = useState(initial.ntfy.enabled);
  const [poll, setPoll] = useState(String(initial.pollIntervalMinutes));
  const [benchmark, setBenchmark] = useState(initial.benchmarkSymbol);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        const minutes = Number(poll);
        // Send every field: SettingsStore.set replaces the stored object wholesale,
        // so an omitted key silently reverts to its default.
        save.mutate({
          ntfy: { url, topic, enabled },
          pollIntervalMinutes:
            Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : initial.pollIntervalMinutes,
          benchmarkSymbol: benchmark.trim().toUpperCase() || initial.benchmarkSymbol,
        });
      }}
    >
      <label>
        ntfy server URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        ntfy topic
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable ntfy notifications
      </label>
      <label>
        Poll interval (minutes)
        <input value={poll} onChange={(e) => setPoll(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Benchmark symbol
        <input value={benchmark} onChange={(e) => setBenchmark(e.target.value)} placeholder="IVV" />
      </label>
      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        The poll interval takes effect when the backend restarts. The benchmark is the index each
        round's analytics compares against.
      </p>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save integrations
      </button>
    </form>
  );
}

function UsageGateForm({ initial }: { initial: UsageGateSettings }) {
  const save = useSaveSettings('usageGate');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [sessionPct, setSessionPct] = useState(String(initial.sessionThresholdPct));
  const [weeklyPct, setWeeklyPct] = useState(String(initial.weeklyThresholdPct));

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        const session = Number(sessionPct);
        const weekly = Number(weeklyPct);
        save.mutate({
          enabled,
          sessionThresholdPct: Number.isFinite(session) && session > 0 ? Math.round(session) : initial.sessionThresholdPct,
          weeklyThresholdPct: Number.isFinite(weekly) && weekly > 0 ? Math.round(weekly) : initial.weeklyThresholdPct,
        });
      }}
    >
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Pause AI calls near Claude subscription usage limits
      </label>
      <label>
        Session threshold (%)
        <input value={sessionPct} onChange={(e) => setSessionPct(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Weekly threshold (%)
        <input value={weeklyPct} onChange={(e) => setWeeklyPct(e.target.value)} inputMode="numeric" />
      </label>
      <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        Checked via the local <code>claude /usage</code> command — free, no API cost. Once usage crosses
        either threshold, check-ins, research, and market-scan runs are skipped (never partially started)
        until the usage window rolls over on its own.
      </p>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save usage gate
      </button>
    </form>
  );
}

function LookAndFeelForm({ initial }: { initial: LookAndFeelSettings }) {
  const save = useSaveSettings('lookAndFeel');
  const [look, setLook] = useState(initial);

  // Preview immediately; the save button persists it.
  useEffect(() => {
    applyTheme(look);
  }, [look]);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(look);
      }}
    >
      <label>
        Theme
        <select
          value={look.theme}
          onChange={(e) => setLook({ ...look, theme: e.target.value as LookAndFeelSettings['theme'] })}
        >
          {['light', 'dark', 'system'].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Accent colour
        <input type="color" value={look.accent} onChange={(e) => setLook({ ...look, accent: e.target.value })} />
      </label>
      <label>
        Default chart style
        <select
          value={look.chartStyle}
          onChange={(e) => setLook({ ...look, chartStyle: e.target.value as LookAndFeelSettings['chartStyle'] })}
        >
          <option value="line">line</option>
          <option value="candles">candles</option>
        </select>
      </label>
      <label>
        Display timezone
        <input value={look.timezone} onChange={(e) => setLook({ ...look, timezone: e.target.value })} />
      </label>
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save look &amp; feel
      </button>
    </form>
  );
}

function NotificationsForm({ initial }: { initial: Settings['notifications'] }) {
  const save = useSaveSettings('notifications');
  const [toggles, setToggles] = useState(initial);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(toggles);
      }}
    >
      {Object.entries(toggles).map(([kind, on]) => (
        <label key={kind} className="row">
          <input type="checkbox" checked={on} onChange={(e) => setToggles({ ...toggles, [kind]: e.target.checked })} />
          Notify on {kind}
        </label>
      ))}
      <ErrorBox error={save.error} />
      <button className="primary" type="submit" disabled={save.isPending}>
        Save notifications
      </button>
    </form>
  );
}

function PasswordForm() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        change.mutate(
          { current, next },
          {
            onSuccess: () => {
              setDone(true);
              setCurrent('');
              setNext('');
            },
          },
        );
      }}
    >
      <label>
        Current password
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      <label>
        New password
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <ErrorBox error={change.error} />
      {done && (
        <p className="gain" style={{ margin: 0 }}>
          Password changed.
        </p>
      )}
      <button className="primary" type="submit" disabled={current === '' || next === '' || change.isPending}>
        Change password
      </button>
    </form>
  );
}

export function SettingsPage() {
  const settings = useSettings();

  if (settings.isPending) return <Spinner label="Loading settings" />;
  if (settings.error) return <ErrorBox error={settings.error} />;
  if (!settings.data) return null;

  return (
    <div className="grid" style={{ maxWidth: 620 }}>
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Settings</h1>
      <Section title="Round defaults">
        <RoundDefaultsForm initial={settings.data.roundDefaults} />
      </Section>
      <Section title="Integrations">
        <IntegrationsForm initial={settings.data.integrations} />
      </Section>
      <Section title="Usage gate">
        <UsageGateForm initial={settings.data.usageGate} />
      </Section>
      <Section title="Look &amp; feel">
        <LookAndFeelForm initial={settings.data.lookAndFeel} />
      </Section>
      <Section title="Notifications">
        <NotificationsForm initial={settings.data.notifications} />
      </Section>
      <Section title="Password">
        <PasswordForm />
      </Section>
    </div>
  );
}
