import { useState } from 'react';
import { usePatchConfig } from '../../api/hooks';
import type { RoundConfig } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';
import { dollarsToCents } from '../../lib/format';

interface FormState {
  name: string;
  profitGoal: string;
  watchlist: string;
  riskProfile: RoundConfig['riskProfile'];
  tradingStyle: RoundConfig['tradingStyle'];
  model: string;
  checkinCron: string;
  stopLossPct: string;
  maxPositionPct: string;
  drawdownPausePct: string;
  stopLossWhenPaused: boolean;
}

function toForm(config: RoundConfig): FormState {
  const pct = (value: number | null): string => (value === null ? '' : String(value));
  return {
    name: config.name,
    profitGoal: (config.profitGoalCents / 100).toFixed(2),
    watchlist: config.watchlist.join(', '),
    riskProfile: config.riskProfile,
    tradingStyle: config.tradingStyle,
    model: config.model,
    checkinCron: config.checkinCron.join('\n'),
    stopLossPct: pct(config.guardrails.stopLossPct),
    maxPositionPct: pct(config.guardrails.maxPositionPct),
    drawdownPausePct: pct(config.guardrails.drawdownPausePct),
    stopLossWhenPaused: config.guardrails.stopLossWhenPaused,
  };
}

/** Blank means "disabled" (null), never 0 — a 0% stop-loss would sell instantly. */
function toPct(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseWatchlist(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
}

export function ConfigPanel({ roundId, config }: { roundId: number; config: RoundConfig }) {
  const [form, setForm] = useState<FormState>(() => toForm(config));
  const patch = usePatchConfig(roundId);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  /**
   * Only changed top-level fields are sent. Guardrails go as a complete object:
   * the backend deep-merges, and a partial object would leave stale keys behind
   * while looking like a full edit to the operator.
   */
  function buildPatch(): Partial<RoundConfig> {
    const body: Partial<RoundConfig> = {};
    if (form.name !== config.name) body.name = form.name;

    const goalCents = dollarsToCents(form.profitGoal);
    if (goalCents !== null && goalCents !== config.profitGoalCents) body.profitGoalCents = goalCents;

    const watchlist = parseWatchlist(form.watchlist);
    if (JSON.stringify(watchlist) !== JSON.stringify(config.watchlist)) body.watchlist = watchlist;

    if (form.riskProfile !== config.riskProfile) body.riskProfile = form.riskProfile;
    if (form.tradingStyle !== config.tradingStyle) body.tradingStyle = form.tradingStyle;
    if (form.model !== config.model) body.model = form.model;

    const cron = form.checkinCron.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (JSON.stringify(cron) !== JSON.stringify(config.checkinCron)) body.checkinCron = cron;

    const guardrails = {
      stopLossPct: toPct(form.stopLossPct),
      maxPositionPct: toPct(form.maxPositionPct),
      drawdownPausePct: toPct(form.drawdownPausePct),
      stopLossWhenPaused: form.stopLossWhenPaused,
    };
    if (JSON.stringify(guardrails) !== JSON.stringify(config.guardrails)) body.guardrails = guardrails;

    return body;
  }

  const pending = buildPatch();
  const dirty = Object.keys(pending).length > 0;

  return (
    <form
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        patch.mutate(pending, { onSuccess: () => setSaved(true) });
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        Starting balance is fixed for the life of a round — it is the skim baseline. Chain a new round to change it.
      </p>

      <label>
        Name
        <input value={form.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <label>
        Profit goal ($)
        <input value={form.profitGoal} onChange={(e) => set('profitGoal', e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Watchlist (comma separated)
        <input value={form.watchlist} onChange={(e) => set('watchlist', e.target.value)} />
      </label>
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
      <label>
        Check-in schedule (one cron expression per line)
        <textarea rows={3} value={form.checkinCron} onChange={(e) => set('checkinCron', e.target.value)} />
      </label>

      <fieldset className="grid" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <legend>Guardrails — blank disables</legend>
        <label>
          Stop-loss %
          <input value={form.stopLossPct} onChange={(e) => set('stopLossPct', e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Max position %
          <input value={form.maxPositionPct} onChange={(e) => set('maxPositionPct', e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Drawdown pause %
          <input
            value={form.drawdownPausePct}
            onChange={(e) => set('drawdownPausePct', e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={form.stopLossWhenPaused}
            onChange={(e) => set('stopLossWhenPaused', e.target.checked)}
          />
          Keep firing stop-losses while paused
        </label>
      </fieldset>

      <ErrorBox error={patch.error} />
      {saved && !dirty && (
        <p className="gain" style={{ margin: 0 }}>
          Saved.
        </p>
      )}
      <button className="primary" type="submit" disabled={!dirty || patch.isPending}>
        Save config
      </button>
    </form>
  );
}
