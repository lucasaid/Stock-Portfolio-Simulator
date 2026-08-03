import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { GuardrailOverride, ReplayService } from '../replay/service.js';
import { requireSession } from './middleware.js';

const NUMBER_KEYS = ['stopLossPct', 'maxPositionPct', 'drawdownPausePct'] as const;

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}

/** Validates a partial guardrail override body: each field is a number, null, or absent. */
function parseOverride(body: unknown): GuardrailOverride | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const override: GuardrailOverride = {};
  for (const key of NUMBER_KEYS) {
    if (record[key] === undefined) continue;
    if (!isNumberOrNull(record[key])) return null;
    override[key] = record[key] as number | null;
  }
  if (record.stopLossWhenPaused !== undefined) {
    if (typeof record.stopLossWhenPaused !== 'boolean') return null;
    override.stopLossWhenPaused = record.stopLossWhenPaused;
  }
  const allowedKeys = new Set([...NUMBER_KEYS, 'stopLossWhenPaused']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key as (typeof NUMBER_KEYS)[number] | 'stopLossWhenPaused')) return null;
  }
  return override;
}

export function replayRoutes(auth: AuthService, db: DB, replay: ReplayService): Router {
  const router = Router();
  router.use('/api/replay', requireSession(auth));

  function roundOr404(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/replay/rounds/:id/sweep', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await replay.sweep(id));
  });

  router.post('/api/replay/rounds/:id', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    const override = parseOverride(req.body);
    if (override === null) {
      res.status(400).json({ error: 'invalid guardrail override' });
      return;
    }
    res.json(await replay.replay(id, override));
  });

  return router;
}
