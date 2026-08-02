import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { Settings, SettingsStore } from '../settings/store.js';
import { requireSession } from './middleware.js';

const NAMESPACES: (keyof Settings)[] = ['roundDefaults', 'integrations', 'lookAndFeel', 'notifications'];

export function settingsRoutes(settings: SettingsStore, auth: AuthService): Router {
  const router = Router();
  router.use('/api/settings', requireSession(auth));

  router.get('/api/settings', (_req, res) => {
    res.json(settings.all());
  });

  router.put('/api/settings/:namespace', (req, res) => {
    const ns = req.params.namespace as keyof Settings;
    if (!NAMESPACES.includes(ns)) {
      res.status(400).json({ error: `unknown namespace: ${String(ns)}` });
      return;
    }
    settings.set(ns, req.body as Settings[typeof ns]);
    res.json({ ok: true });
  });

  return router;
}
