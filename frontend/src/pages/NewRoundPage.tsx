import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateRound, useRound, useRounds, useSettings } from '../api/hooks';
import type { Market, RoundConfig } from '../api/types';
import { CronScheduleField } from '../components/CronScheduleField';
import { ErrorBox } from '../components/ErrorBox';
import { Spinner } from '../components/Spinner';
import { WatchlistField } from '../components/WatchlistField';
import { dollarsToCents } from '../lib/format';
import { roundWarnings } from './round/warnings';

interface WizardState {
  name: string;
  startingBalance: string;
  profitGoal: string;
  markets: Market[];
  watchlist: string;
  riskProfile: RoundConfig['riskProfile'];
  tradingStyle: RoundConfig['tradingStyle'];
  model: string;
  checkinCron: string;
  stopLossPct: string;
  maxPositionPct: string;
  drawdownPausePct: string;
  stopLossWhenPaused: boolean;
  autoWatchlist: boolean;
}

function pctOrNull(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function pctToString(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Both the defaults seed and the carry-over copy produce this shape. */
function toWizardState(config: Omit<RoundConfig, 'name'>, name: string): WizardState {
  return {
    name,
    startingBalance: (config.startingBalanceCents / 100).toFixed(2),
    profitGoal: (config.profitGoalCents / 100).toFixed(2),
    markets: config.markets,
    watchlist: config.watchlist.join(', '),
    riskProfile: config.riskProfile,
    tradingStyle: config.tradingStyle,
    model: config.model,
    checkinCron: config.checkinCron.join('\n'),
    stopLossPct: pctToString(config.guardrails.stopLossPct),
    maxPositionPct: pctToString(config.guardrails.maxPositionPct),
    drawdownPausePct: pctToString(config.guardrails.drawdownPausePct),
    stopLossWhenPaused: config.guardrails.stopLossWhenPaused,
    autoWatchlist: config.autoWatchlist,
  };
}

export function NewRoundPage() {
  const settings = useSettings();
  const rounds = useRounds();
  const create = useCreateRound();
  const [carryFrom, setCarryFrom] = useState<number | null>(null);
  const carried = useRound(carryFrom ?? 0);
  const [form, setForm] = useState<WizardState | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Seed from global defaults once they load (spec §6.1: defaults pre-fill, per-round overrides win).
  useEffect(() => {
    if (form !== null || !settings.data) return;
    setForm(toWizardState(settings.data.roundDefaults, ''));
  }, [settings.data, form]);

  // Carry-over copies the finished round's config and names the sequel.
  useEffect(() => {
    if (carryFrom === null || !carried.data) return;
    const config = carried.data.config;
    setForm(toWizardState(config, `${config.name} #2`));
  }, [carryFrom, carried.data]);

  if (settings.isPending || form === null) return <Spinner label="Loading defaults" />;

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]): void {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  }

  const startingBalanceCents = dollarsToCents(form.startingBalance);
  const profitGoalCents = dollarsToCents(form.profitGoal);
  const watchlist = form.watchlist.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s !== '');
  const checkinCron = form.checkinCron.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  const guardrails = {
    stopLossPct: pctOrNull(form.stopLossPct),
    maxPositionPct: pctOrNull(form.maxPositionPct),
    drawdownPausePct: pctOrNull(form.drawdownPausePct),
    stopLossWhenPaused: form.stopLossWhenPaused,
  };
  const fees = settings.data!.roundDefaults.fees;

  const warnings =
    startingBalanceCents === null || profitGoalCents === null
      ? []
      : roundWarnings({
          startingBalanceCents, profitGoalCents, markets: form.markets,
          tradingStyle: form.tradingStyle, guardrails, fees, watchlist, checkinCron,
        });

  const valid =
    form.name.trim() !== '' &&
    startingBalanceCents !== null && startingBalanceCents > 0 &&
    profitGoalCents !== null && profitGoalCents > 0 &&
    form.markets.length > 0;

  const finished = (rounds.data ?? []).filter((r) => ['goal_reached', 'busted', 'archived'].includes(r.status));

  return (
    <section className="grid" style={{ maxWidth: 560 }}>
      <h1 style={{ margin: 0, fontSize: '1.3rem' }}>New round</h1>

      {createdId !== null && (
        <p className="gain">
          Round created. <Link to={`/rounds/${createdId}`}>Open it</Link>.
        </p>
      )}

      <label>
        Carry over from a finished round
        <select
          value={carryFrom ?? ''}
          onChange={(e) => setCarryFrom(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">Start fresh</option>
          {finished.map((round) => (
            <option key={round.id} value={round.id}>
              {round.name}
            </option>
          ))}
        </select>
      </label>

      <form
        className="grid"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name: form.name.trim(),
              startingBalanceCents: startingBalanceCents!,
              profitGoalCents: profitGoalCents!,
              markets: form.markets,
              watchlist,
              riskProfile: form.riskProfile,
              tradingStyle: form.tradingStyle,
              model: form.model,
              checkinCron,
              guardrails,
              autoWatchlist: form.autoWatchlist,
            },
            { onSuccess: (created) => setCreatedId(created.id) },
          );
        }}
      >
        <label>
          Round name
          <input value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          Starting balance ($)
          <input
            value={form.startingBalance}
            onChange={(e) => set('startingBalance', e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          Profit goal ($)
          <input value={form.profitGoal} onChange={(e) => set('profitGoal', e.target.value)} inputMode="decimal" />
        </label>

        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <legend>Markets</legend>
          {(['ASX', 'US', 'CRYPTO'] as Market[]).map((market) => (
            <label key={market} className="row">
              <input
                type="checkbox"
                checked={form.markets.includes(market)}
                onChange={(e) =>
                  set('markets', e.target.checked ? [...form.markets, market] : form.markets.filter((m) => m !== market))
                }
              />
              {market}
            </label>
          ))}
        </fieldset>

        <WatchlistField value={form.watchlist} onChange={(value) => set('watchlist', value)} markets={form.markets} />
        <label className="row">
          <input
            type="checkbox"
            checked={form.autoWatchlist}
            onChange={(e) => set('autoWatchlist', e.target.checked)}
          />
          Auto-manage watchlist
        </label>
        <small className="muted">
          On: the agent scans the market and edits the watchlist itself (a scan at creation, then
          weekly). Off with symbols above: strict — no scanning, no edits. Off with an empty
          watchlist: one bootstrap scan at creation to choose what to track, then frozen.
        </small>
        <label>
          Risk profile
          <select
            value={form.riskProfile}
            onChange={(e) => set('riskProfile', e.target.value as RoundConfig['riskProfile'])}
          >
            {['conservative', 'balanced', 'aggressive', 'custom'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Trading style
          <select
            value={form.tradingStyle}
            onChange={(e) => set('tradingStyle', e.target.value as RoundConfig['tradingStyle'])}
          >
            {['day', 'swing', 'long'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input value={form.model} onChange={(e) => set('model', e.target.value)} />
        </label>
        <CronScheduleField value={form.checkinCron} onChange={(value) => set('checkinCron', value)} />

        <fieldset className="grid" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <legend>Guardrails — blank disables</legend>
          <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
            Blank means disabled, never 0 — a 0% stop-loss sells instantly.
          </p>
          <label>
            Stop-loss %
            <input value={form.stopLossPct} onChange={(e) => set('stopLossPct', e.target.value)} inputMode="decimal" />
          </label>
          <small className="muted">
            Sell automatically if the price falls this far below what you paid. Leave blank to
            disable — but a blank stop-loss means a bad position can run unchecked.
          </small>
          <label>
            Max position %
            <input
              value={form.maxPositionPct}
              onChange={(e) => set('maxPositionPct', e.target.value)}
              inputMode="decimal"
            />
          </label>
          <small className="muted">Cap how much of the starting balance can sit in one symbol at cost. Blank means no cap.</small>
          <label>
            Drawdown pause %
            <input
              value={form.drawdownPausePct}
              onChange={(e) => set('drawdownPausePct', e.target.value)}
              inputMode="decimal"
            />
          </label>
          <small className="muted">
            Pause the round (new buys blocked, protective stops keep firing) once total equity has
            fallen this far below the starting balance. Blank means it never auto-pauses.
          </small>
          <label className="row">
            <input
              type="checkbox"
              checked={form.stopLossWhenPaused}
              onChange={(e) => set('stopLossWhenPaused', e.target.checked)}
            />
            Keep firing stop-losses while paused
          </label>
        </fieldset>

        {warnings.length > 0 && (
          <div className="panel" style={{ borderColor: 'var(--loss)' }}>
            <strong>Before you start:</strong>
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        <ErrorBox error={create.error} />
        <button className="primary" type="submit" disabled={!valid || create.isPending}>
          Create round
        </button>
      </form>
    </section>
  );
}
