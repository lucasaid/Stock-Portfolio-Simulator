/** Server entrypoint: wiring only — every component here is tested elsewhere. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './api/app.js';
import { AuthService } from './auth/service.js';
import { PaperBroker } from './broker/paper.js';
import { openDb } from './db/connection.js';
import { logEvent } from './db/events.js';
import { migrate } from './db/migrate.js';
import { MarketDataService } from './market/data.js';
import { yahooFetcher } from './market/yahoo.js';
import { NotificationDispatcher, NtfyNotifier } from './notify/ntfy.js';
import { RoundService } from './rounds/service.js';
import { start as startScheduler } from './scheduler.js';
import { SettingsStore } from './settings/store.js';

const DB_PATH = process.env.DB_PATH ?? './data/stake.db';
const PORT = Number(process.env.PORT ?? 3000);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
migrate(db);

const auth = new AuthService(db);
const settings = new SettingsStore(db);
const rounds = new RoundService(db, new PaperBroker(db));
const market = new MarketDataService(db, yahooFetcher);
const notifier = new NtfyNotifier(() => settings.get('integrations').ntfy);
const dispatcher = new NotificationDispatcher(db, settings, notifier);

if (!auth.hasUsers()) {
  console.warn('no user exists yet — create one with: npm run cli -- create-user <username>');
}

const pollMinutes = settings.get('integrations').pollIntervalMinutes;
const stopScheduler = startScheduler({ db, rounds, market }, `*/${pollMinutes} * * * *`);
const stopDispatcher = dispatcher.start();

const app = buildApp({ db, auth, settings, rounds, market });
const server = app.listen(PORT, () => {
  logEvent(db, 'info', 'server_started', `API listening on :${PORT}`);
  console.log(`stake_portfolio backend on http://localhost:${PORT}`);
});

function shutdown(): void {
  console.log('shutting down…');
  stopScheduler();
  stopDispatcher();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
