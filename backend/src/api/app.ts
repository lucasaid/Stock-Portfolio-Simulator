import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DecisionService } from '../agent/decision.js';
import type { DB } from '../db/connection.js';
import type { MarketDataService } from '../market/data.js';
import type { RoundService } from '../rounds/service.js';
import type { SettingsStore } from '../settings/store.js';
import { agentRoutes } from './agent-routes.js';
import { authRoutes } from './auth-routes.js';
import { eventsRoutes } from './events-routes.js';
import { roundsRoutes } from './rounds-routes.js';
import { settingsRoutes } from './settings-routes.js';
import { errorHandler, loginRateLimiter, notFound } from './middleware.js';

export interface ApiDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
}

export function buildApp(deps: ApiDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(authRoutes(deps.auth, loginRateLimiter()));
  app.use(settingsRoutes(deps.settings, deps.auth));
  app.use(roundsRoutes(deps));
  app.use(eventsRoutes(deps.db, deps.auth));
  app.use(agentRoutes(deps.db, deps.auth, deps.decision));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
