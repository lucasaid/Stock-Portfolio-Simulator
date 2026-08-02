import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { RoundConfig } from '../engine/types.js';
import type { MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
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
  'riskProfile', 'tradingStyle', 'guardrails', 'fees', 'model', 'checkinCron',
];

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function roundsRoutes(deps: RoundsDeps): Router {
  const { db, auth, settings, rounds } = deps;
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
    if (!Array.isArray(config.markets) || config.markets.some((m) => m !== 'ASX' && m !== 'US')) {
      res.status(400).json({ error: 'markets must be ASX and/or US' });
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
    equity: 'SELECT * FROM equity_snapshots WHERE round_id = ? ORDER BY id DESC LIMIT 2000',
  };

  for (const [name, sql] of Object.entries(DATA_QUERIES)) {
    router.get(`/api/rounds/:id/${name}`, (req, res) => {
      const id = loadRound(req.params.id, res);
      if (id === null) return;
      res.json(db.prepare(sql).all(id));
    });
  }

  return router;
}
