/**
 * Thin operator CLI:
 *   npm run cli -- create-user <username>   (prompts for password)
 *   npm run cli -- status                   (lists rounds)
 * DB path via DB_PATH env (default ./data/stake.db), matching index.ts.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AuthService } from './auth/service.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';

const DB_PATH = process.env.DB_PATH ?? './data/stake.db';

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  migrate(db);
  const [command, ...args] = process.argv.slice(2);

  if (command === 'create-user') {
    const username = args[0];
    if (!username) {
      console.error('usage: npm run cli -- create-user <username>');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.warn('note: password input is visible in this terminal');
    const password = await rl.question('password: ');
    rl.close();
    if (password.length < 8) {
      console.error('password must be at least 8 characters');
      process.exit(1);
    }
    const auth = new AuthService(db);
    await auth.createUser(username, password);
    console.log(`user '${username}' created`);
    return;
  }

  if (command === 'status') {
    const rows = db
      .prepare('SELECT id, name, status, cash_cents, profit_goal_cents FROM rounds ORDER BY id')
      .all() as { id: number; name: string; status: string; cash_cents: number; profit_goal_cents: number }[];
    if (rows.length === 0) {
      console.log('no rounds');
      return;
    }
    for (const r of rows) {
      console.log(`#${r.id} ${r.name} [${r.status}] cash $${(r.cash_cents / 100).toFixed(2)} goal $${(r.profit_goal_cents / 100).toFixed(2)}`);
    }
    return;
  }

  if (command === 'checkin') {
    const roundId = Number(args[0]);
    if (!Number.isInteger(roundId)) {
      console.error('usage: npm run cli -- checkin <roundId>');
      process.exit(1);
    }
    const { PaperBroker } = await import('./broker/paper.js');
    const { RoundService } = await import('./rounds/service.js');
    const { MarketDataService } = await import('./market/data.js');
    const { yahooFetcher } = await import('./market/yahoo.js');
    const { DecisionService } = await import('./agent/decision.js');
    const { SdkAgentRunner } = await import('./agent/sdk-runner.js');
    const rounds = new RoundService(db, new PaperBroker(db));
    const market = new MarketDataService(db, yahooFetcher);
    const decision = new DecisionService({ db, rounds, market }, new SdkAgentRunner());
    const outcome = await decision.runCheckin(roundId);
    console.log(`check-in: ${outcome.status} (${outcome.detail})`);
    return;
  }

  console.error('usage: npm run cli -- <create-user <username> | status | checkin <roundId>>');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
