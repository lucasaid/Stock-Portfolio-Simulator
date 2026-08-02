import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { DecisionService } from '../agent/decision.js';
import { requireSession } from './middleware.js';

export function agentRoutes(db: DB, auth: AuthService, decision: DecisionService): Router {
  const router = Router();
  router.use('/api/rounds/:id/checkin', requireSession(auth));
  router.use('/api/rounds/:id/checkins', requireSession(auth));
  router.use('/api/rounds/:id/journal', requireSession(auth));
  router.use('/api/rounds/:id/summaries', requireSession(auth));

  function exists(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.post('/api/rounds/:id/checkin', async (req, res) => {
    const id = exists(req.params.id, res);
    if (id === null) return;
    const outcome = await decision.runCheckin(id);
    res.json(outcome);
  });

  const LISTS: Record<string, string> = {
    checkins: 'SELECT id, ts, status, tokens_used, actions_json FROM checkins WHERE round_id = ? ORDER BY id DESC LIMIT 200',
    journal: 'SELECT id, checkin_id, author, note, created_at FROM journal_entries WHERE round_id = ? ORDER BY id DESC LIMIT 500',
    summaries: "SELECT day, digest_json, narrative, created_at FROM daily_summaries WHERE round_id = ? ORDER BY day DESC LIMIT 400",
  };
  for (const [name, sql] of Object.entries(LISTS)) {
    router.get(`/api/rounds/:id/${name}`, (req, res) => {
      const id = exists(req.params.id, res);
      if (id === null) return;
      res.json(db.prepare(sql).all(id));
    });
  }

  return router;
}
