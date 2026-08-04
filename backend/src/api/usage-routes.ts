import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { UsageGateService } from '../agent/usage-gate.js';
import { requireSession } from './middleware.js';

export function usageRoutes(auth: AuthService, usageGate: UsageGateService): Router {
  const router = Router();
  router.use('/api/usage', requireSession(auth));

  router.get('/api/usage', async (_req, res) => {
    res.json(await usageGate.status());
  });

  return router;
}
