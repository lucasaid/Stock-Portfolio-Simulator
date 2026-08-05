import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { OptimizerService } from '../optimizer/service.js';
import { requireSession } from './middleware.js';

export function optimizerRoutes(auth: AuthService, optimizer: OptimizerService): Router {
  const router = Router();
  router.use('/api/optimizer', requireSession(auth));

  router.get('/api/optimizer', (_req, res) => {
    res.json(optimizer.list());
  });

  router.post('/api/optimizer/run', async (req, res) => {
    const webSearch = req.body?.webSearch === true;
    res.json(await optimizer.run(webSearch));
  });

  return router;
}
