import { Router } from 'express';
import type { AnalyticsService } from '../analytics/service.js';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import { summarizeRoundTrips } from '../engine/analytics.js';
import { normalizeSymbol } from '../market/symbols.js';
import type { SettingsStore } from '../settings/store.js';
import { requireSession } from './middleware.js';

export function analyticsRoutes(
  auth: AuthService,
  db: DB,
  analytics: AnalyticsService,
  settings: SettingsStore,
): Router {
  const router = Router();
  router.use('/api/analytics', requireSession(auth));

  function roundOr404(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/analytics/rounds/:id', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await analytics.roundAnalytics(id));
  });

  router.get('/api/analytics/rounds/:id/benchmark', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    const requested =
      req.query.symbol === undefined ? settings.get('integrations').benchmarkSymbol : String(req.query.symbol);
    const symbol = normalizeSymbol(requested);
    if (symbol === null) {
      res.status(400).json({ error: 'invalid benchmark symbol' });
      return;
    }
    res.json(await analytics.benchmark(id, symbol));
  });

  router.get('/api/analytics/rounds/:id/decisions', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await analytics.decisionOutcomes(id));
  });

  /** Cross-round comparison (spec §6): one stats block per round plus the totals. */
  router.get('/api/analytics/summary', async (_req, res) => {
    const rounds = db.prepare('SELECT id, name, status FROM rounds ORDER BY id').all() as {
      id: number; name: string; status: string;
    }[];

    const perRound = [];
    const allTrips = [];
    for (const round of rounds) {
      const result = await analytics.roundAnalytics(round.id);
      perRound.push({
        id: round.id,
        name: round.name,
        status: round.status,
        stats: result.stats,
        costs: { totalFeesCents: result.costs.totalFeesCents },
        tokenTotals: result.tokenTotals,
      });
      allTrips.push(...result.trips);
    }

    res.json({ rounds: perRound, totals: summarizeRoundTrips(allTrips) });
  });

  return router;
}
