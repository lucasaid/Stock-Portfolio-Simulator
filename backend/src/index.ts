/** Server entrypoint: wiring only — every component here is tested elsewhere. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import cron from 'node-cron';
import { buildApp } from './api/app.js';
import { DecisionService } from './agent/decision.js';
import { SdkAgentRunner } from './agent/sdk-runner.js';
import { startCheckinScheduler } from './agent/checkin-scheduler.js';
import { runDailySummaries } from './agent/summaries.js';
import { AuthService } from './auth/service.js';
import { PaperBroker } from './broker/paper.js';
import { openDb } from './db/connection.js';
import { logEvent } from './db/events.js';
import { migrate } from './db/migrate.js';
import { MarketDataService } from './market/data.js';
import { MarketHistoryService } from './market/history.js';
import { SymbolRegistry } from './market/symbols.js';
import { yahooBarFetcher, yahooFetcher } from './market/yahoo.js';
import { NotificationDispatcher, NtfyNotifier } from './notify/ntfy.js';
import { RoundService } from './rounds/service.js';
import { start as startScheduler } from './scheduler.js';
import { SettingsStore } from './settings/store.js';

const DB_PATH = process.env.DB_PATH ?? './data/stake.db';
const PORT = Number(process.env.PORT ?? 3000);
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

/**
 * Sydney's local "yesterday" as a UTC-midnight-anchored YYYY-MM-DD string.
 * The cron fires on the Sydney clock, so we must compute yesterday relative
 * to Sydney's local date — not UTC's — or we're off by one for most of the
 * day (Sydney is ahead of UTC). Note: the digest itself still buckets
 * activity by UTC day (documented plan simplification); this only fixes
 * which day-string gets summarized.
 */
function sydneyYesterday(now = new Date()): string {
  const sydneyToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // en-CA gives YYYY-MM-DD
  const d = new Date(`${sydneyToday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
migrate(db);

// A crash between a checkin's INSERT (status 'running') and its UPDATE
// leaves a permanently 'running' row. Sweep those on boot.
const stranded = db.prepare("UPDATE checkins SET status = 'interrupted' WHERE status = 'running'").run();
if (stranded.changes > 0) {
  logEvent(db, 'warn', 'checkin_interrupted', `marked ${stranded.changes} check-in(s) interrupted after restart`);
}

const auth = new AuthService(db);
const settings = new SettingsStore(db);
const rounds = new RoundService(db, new PaperBroker(db));
const market = new MarketDataService(db, yahooFetcher);
const history = new MarketHistoryService(db, yahooBarFetcher);
const symbols = new SymbolRegistry(db);
const notifier = new NtfyNotifier(() => settings.get('integrations').ntfy);
const dispatcher = new NotificationDispatcher(db, settings, notifier);

if (!auth.hasUsers()) {
  console.warn('no user exists yet — create one with: npm run cli -- create-user <username>');
}

const pollMinutes = settings.get('integrations').pollIntervalMinutes;
const stopScheduler = startScheduler({ db, rounds, market, symbols }, `*/${pollMinutes} * * * *`);
const stopDispatcher = dispatcher.start();

const runner = new SdkAgentRunner();
const decision = new DecisionService({ db, rounds, market }, runner);
if (!process.env.ANTHROPIC_BASE_URL || !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn('ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN not set — check-ins will fail until scripts/setup-claude-auth.sh is run and the env configured');
}
const stopCheckins = startCheckinScheduler(db, decision);
const summaryTask = cron.schedule('10 8 * * *', () => {
  const yesterday = sydneyYesterday();
  void runDailySummaries({ db, rounds }, runner, yesterday);
}, { timezone: 'Australia/Sydney' });

const app = buildApp({
  db, auth, settings, rounds, market, decision, history, symbols,
  cookieSecure: COOKIE_SECURE, trustProxy: TRUST_PROXY,
});
const server = app.listen(PORT, () => {
  logEvent(db, 'info', 'server_started', `API listening on :${PORT}`);
  console.log(`stake_portfolio backend on http://localhost:${PORT}`);
});

function shutdown(): void {
  console.log('shutting down…');
  stopScheduler();
  stopDispatcher();
  stopCheckins();
  void summaryTask.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
