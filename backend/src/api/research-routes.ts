import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { ResearchService } from '../research/service.js';
import { requireSession } from './middleware.js';

export function researchRoutes(db: DB, auth: AuthService, research: ResearchService): Router {
  const router = Router();
  router.use('/api/rounds/:id/briefings', requireSession(auth));
  router.use('/api/rounds/:id/research', requireSession(auth));

  function roundOr404(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/rounds/:id/briefings', (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(research.list(id));
  });

  router.post('/api/rounds/:id/research', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await research.runBriefing(id));
  });

  return router;
}
