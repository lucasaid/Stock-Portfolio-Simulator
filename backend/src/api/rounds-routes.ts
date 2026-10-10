import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { RoundConfig } from '../engine/types.js';
import { ALL_MARKETS } from '../market/adapters.js';
import type { MarketDataService } from '../market/data.js';
import { marketForSymbol } from '../market/data.js';
import type { RoundService, RoundStatus } from '../rounds/service.js';
import type { SettingsStore } from '../settings/store.js';
import { requireSession } from './middleware.js';

export interface RoundsDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
}

/** Fields callers may set at create time (everything except computed state). */
const CREATE_KEYS: (keyof RoundConfig)[] = [
  'name', 'startingBalanceCents', 'profitGoalCents', 'markets', 'watchlist',
  'riskProfile', 'tradingStyle', 'guardrails', 'fees', 'model', 'checkinCron', 'autoWatchlist', 'riskPrompt', 'stylePrompt',
];

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function roundsRoutes(deps: RoundsDeps): Router {
  const { db, auth, settings, rounds, market } = deps;
  const router = Router();
  router.use('/api/rounds', requireSession(auth));

  router.get('/api/rounds', (_req, res) => {
    const rows = db.prepare('SELECT id, name, status, starting_balance_cents, cash_cents, profit_goal_cents FROM rounds ORDER BY id DESC').all() as {
      id: number;
    }[];
    res.json(rows.map((r) => ({ ...r, totalSkimsCents: rounds.totalSkimsCents(r.id) })));
  });

  router.post('/api/rounds', (req, res) => {
    const body = (req.body ?? {}) as Partial<RoundConfig>;
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const overrides: Partial<RoundConfig> = {};
    for (const key of CREATE_KEYS) {
      if (body[key] !== undefined) (overrides as Record<string, unknown>)[key] = body[key];
    }
    const defaults = settings.get('roundDefaults');
    const config: RoundConfig = {
      ...defaults,
      ...overrides,
      name: body.name.trim(),
      guardrails: { ...defaults.guardrails, ...(body.guardrails ?? {}) },
      fees: { ...defaults.fees, ...(body.fees ?? {}) },
    };
    if (!isPositiveInt(config.startingBalanceCents) || !isPositiveInt(config.profitGoalCents)) {
      res.status(400).json({ error: 'startingBalanceCents and profitGoalCents must be positive integers' });
      return;
    }
    if (!Array.isArray(config.markets) || config.markets.some((m) => !ALL_MARKETS.includes(m))) {
      res.status(400).json({ error: `markets must be one of ${ALL_MARKETS.join(', ')}` });
      return;
    }
    const id = rounds.create(config);
    res.status(201).json({ id });
  });

  /** Loads the round or 404s. Returns null after responding. */
  function loadRound(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    const exists = db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id);
    if (!exists) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/rounds/:id', (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    res.json({
      round: rounds.get(id),
      config: rounds.config(id),
      positions: rounds.openPositions(id),
      totalSkimsCents: rounds.totalSkimsCents(id),
    });
  });

  const DATA_QUERIES: Record<string, string> = {
    ledger: 'SELECT * FROM ledger_entries WHERE round_id = ? ORDER BY id DESC LIMIT 500',
    trades: 'SELECT * FROM trades WHERE round_id = ? ORDER BY id DESC LIMIT 500',
    equity: 'SELECT * FROM equity_snapshots WHERE round_id = ? ORDER BY ts DESC LIMIT 2000',
  };

  for (const [name, sql] of Object.entries(DATA_QUERIES)) {
    router.get(`/api/rounds/:id/${name}`, (req, res) => {
      const id = loadRound(req.params.id, res);
      if (id === null) return;
      res.json(db.prepare(sql).all(id));
    });
  }

  const TRANSITIONS: Record<string, { from: RoundStatus[]; to: RoundStatus }> = {
    pause: { from: ['active', 'takeover'], to: 'paused' },
    resume: { from: ['paused', 'takeover'], to: 'active' },
    takeover: { from: ['active', 'paused'], to: 'takeover' },
    release: { from: ['takeover'], to: 'active' },
    archive: { from: ['paused', 'goal_reached', 'busted'], to: 'archived' },
  };

  router.post('/api/rounds/:id/status', (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    const action = (req.body as { action?: string } | undefined)?.action ?? '';
    const transition = TRANSITIONS[action];
    if (!transition) {
      res.status(400).json({ error: `unknown action: ${action}` });
      return;
    }
    const current = rounds.get(id).status;
    if (!transition.from.includes(current)) {
      res.status(409).json({ error: `cannot ${action} a ${current} round` });
      return;
    }
    rounds.setStatus(id, transition.to, `operator ${action}`);
    res.json({ status: transition.to });
  });

  router.post('/api/kill', requireSession(auth), (_req, res) => {
    const ids = db.prepare(`SELECT id FROM rounds WHERE status IN ('active', 'takeover')`).all() as { id: number }[];
    for (const { id } of ids) rounds.setStatus(id, 'paused', 'kill switch');
    logEvent(db, 'warn', 'kill_switch', `kill switch: paused ${ids.length} rounds`);
    res.json({ paused: ids.length });
  });

  /** Live config edit (spec §2.6). startingBalanceCents is immutable mid-round: it is the skim baseline. */
  const PATCHABLE: (keyof RoundConfig)[] = [
    'name', 'profitGoalCents', 'markets', 'watchlist', 'riskProfile',
    'tradingStyle', 'guardrails', 'fees', 'model', 'checkinCron', 'autoWatchlist', 'riskPrompt', 'stylePrompt',
  ];

  router.patch('/api/rounds/:id/config', (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    const body = (req.body ?? {}) as Partial<RoundConfig>;
    if (body.startingBalanceCents !== undefined) {
      res.status(400).json({ error: 'startingBalanceCents cannot change mid-round (skim baseline); chain a new round instead' });
      return;
    }
    const current = rounds.config(id);
    // Deep-merge partial nested objects over the current config so a partial edit can't strip keys
    // (mirrors the create-endpoint merge fix; see commit 0cb6f77).
    if (body.guardrails !== undefined) body.guardrails = { ...current.guardrails, ...body.guardrails };
    if (body.fees !== undefined) body.fees = { ...current.fees, ...body.fees };
    const next = { ...current };
    const now = new Date().toISOString();
    const insertEvent = db.prepare(
      'INSERT INTO config_events (round_id, changed_by, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let changed = 0;
    for (const key of PATCHABLE) {
      if (body[key] === undefined) continue;
      const oldJson = JSON.stringify(current[key]);
      const newJson = JSON.stringify(body[key]);
      if (oldJson === newJson) continue;
      (next as Record<string, unknown>)[key] = body[key];
      insertEvent.run(id, 'operator', key, oldJson, newJson, now);
      changed += 1;
    }
    if (changed === 0) {
      res.json({ changed: 0 });
      return;
    }
    db.prepare('UPDATE rounds SET config_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), now, id);
    if (body.profitGoalCents !== undefined) {
      db.prepare('UPDATE rounds SET profit_goal_cents = ? WHERE id = ?').run(body.profitGoalCents, id);
    }
    logEvent(db, 'info', 'config_change', `round ${id}: operator changed ${changed} config field(s)`, id);
    res.json({ changed });
  });

  router.post('/api/rounds/:id/orders', async (req, res) => {
    const id = loadRound(req.params.id, res);
    if (id === null) return;
    const body = (req.body ?? {}) as { symbol?: string; side?: string; amountCents?: number; quantity?: number | 'all' };
    const { symbol, side } = body;
    if (typeof symbol !== 'string' || symbol.trim() === '' || (side !== 'buy' && side !== 'sell')) {
      res.status(400).json({ error: 'symbol and side (buy|sell) required' });
      return;
    }
    if (side === 'buy' && !isPositiveInt(body.amountCents)) {
      res.status(400).json({ error: 'buys require amountCents (positive integer)' });
      return;
    }
    if (side === 'sell' && body.quantity !== 'all' && !(typeof body.quantity === 'number' && body.quantity > 0)) {
      res.status(400).json({ error: "sells require quantity (positive number or 'all')" });
      return;
    }

    const quotes = await market.poll([symbol]);
    const quote = quotes.get(symbol);
    if (!quote) {
      res.status(422).json({ error: `no quote available for ${symbol}` });
      return;
    }
    const audUsd = quote.currency === 'USD' ? await market.audUsdRate() : 1;

    const result =
      side === 'buy'
        ? rounds.buy(id, symbol, marketForSymbol(symbol), body.amountCents!, quote, audUsd, 'operator')
        : rounds.sell(id, symbol, body.quantity!, quote, audUsd, 'operator');

    if (result.status === 'rejected') {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.status(201).json(result);
  });

  return router;
}
