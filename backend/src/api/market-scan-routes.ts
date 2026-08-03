import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import type { MarketScanService } from '../market-scan/service.js';
import { requireSession } from './middleware.js';

export interface MarketScanRoutesDeps {
  auth: AuthService;
  db: DB;
  marketScan: MarketScanService;
}

export function marketScanRoutes(deps: MarketScanRoutesDeps): Router {
  const { auth, db, marketScan } = deps;
  const router = Router();
  router.use('/api/rounds/:id/scans', requireSession(auth));
  router.use('/api/rounds/:id/scan', requireSession(auth));

  function roundOr404(idParam: string, res: import('express').Response): number | null {
    const id = Number(idParam);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'round not found' });
      return null;
    }
    return id;
  }

  router.get('/api/rounds/:id/scans', (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(marketScan.list(id));
  });

  router.post('/api/rounds/:id/scan', async (req, res) => {
    const id = roundOr404(req.params.id, res);
    if (id === null) return;
    res.json(await marketScan.runScan(id));
  });

  return router;
}
