import cookieParser from 'cookie-parser';
import type { AnalyticsService } from '../analytics/service.js';
import type { UsageGateService } from '../agent/usage-gate.js';
import express, { type Express } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DecisionService } from '../agent/decision.js';
import type { DB } from '../db/connection.js';
import type { CandidateFetcher } from '../market/candidates.js';
import type { MarketDataService } from '../market/data.js';
import type { MarketHistoryService } from '../market/history.js';
import type { SymbolRegistry } from '../market/symbols.js';
import type { MarketScanService } from '../market-scan/service.js';
import type { OptimizerService } from '../optimizer/service.js';
import type { ReplayService } from '../replay/service.js';
import type { ResearchService } from '../research/service.js';
import type { RoundService } from '../rounds/service.js';
import type { SettingsStore } from '../settings/store.js';
import { agentRoutes } from './agent-routes.js';
import { analyticsRoutes } from './analytics-routes.js';
import { authRoutes } from './auth-routes.js';
import { eventsRoutes } from './events-routes.js';
import { marketRoutes } from './market-routes.js';
import { marketScanRoutes } from './market-scan-routes.js';
import { optimizerRoutes } from './optimizer-routes.js';
import { replayRoutes } from './replay-routes.js';
import { researchRoutes } from './research-routes.js';
import { roundsRoutes } from './rounds-routes.js';
import { settingsRoutes } from './settings-routes.js';
import { usageRoutes } from './usage-routes.js';
import { errorHandler, loginRateLimiter, notFound } from './middleware.js';

export interface ApiDeps {
  db: DB;
  auth: AuthService;
  settings: SettingsStore;
  rounds: RoundService;
  market: MarketDataService;
  decision: DecisionService;
  analytics: AnalyticsService;
  replay: ReplayService;
  research: ResearchService;
  marketScan: MarketScanService;
  optimizer: OptimizerService;
  usageGate: UsageGateService;
  history: MarketHistoryService;
  symbols: SymbolRegistry;
  candidates: CandidateFetcher;
  /** TLS deployment flags. Behind nginx set both. */
  cookieSecure?: boolean;
  trustProxy?: boolean;
}

export function buildApp(deps: ApiDeps): Express {
  const app = express();
  // Behind nginx, req.ip must reflect X-Forwarded-For or the login rate limiter
  // buckets every request under the proxy's address (spec §6.1).
  if (deps.trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(authRoutes(deps.auth, loginRateLimiter(), deps.cookieSecure ?? false));
  app.use(settingsRoutes(deps.settings, deps.auth));
  app.use(roundsRoutes(deps));
  app.use(marketRoutes(deps.auth, deps.history, deps.symbols, deps.market, deps.candidates));
  app.use(eventsRoutes(deps.db, deps.auth));
  app.use(agentRoutes(deps.db, deps.auth, deps.decision));
  app.use(analyticsRoutes(deps.auth, deps.db, deps.analytics, deps.settings));
  app.use(replayRoutes(deps.auth, deps.db, deps.replay));
  app.use(researchRoutes(deps.db, deps.auth, deps.research));
  app.use(marketScanRoutes({ auth: deps.auth, db: deps.db, marketScan: deps.marketScan }));
  app.use(optimizerRoutes(deps.auth, deps.optimizer));
  app.use(usageRoutes(deps.auth, deps.usageGate));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
