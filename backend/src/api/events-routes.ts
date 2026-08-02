import { Router } from 'express';
import type { AuthService } from '../auth/service.js';
import type { DB } from '../db/connection.js';
import { requireSession } from './middleware.js';

export interface EventRow {
  id: number;
  round_id: number | null;
  level: string;
  kind: string;
  message: string;
  created_at: string;
}

export function recentEvents(db: DB, afterId: number, roundId?: number, limit = 200): EventRow[] {
  if (roundId !== undefined) {
    return db
      .prepare('SELECT * FROM event_log WHERE id > ? AND round_id = ? ORDER BY id LIMIT ?')
      .all(afterId, roundId, limit) as EventRow[];
  }
  return db.prepare('SELECT * FROM event_log WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as EventRow[];
}

export function latestEventId(db: DB): number {
  const { m } = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM event_log').get() as { m: number };
  return m;
}

const SSE_POLL_MS = 1000;
const SSE_HEARTBEAT_MS = 25_000;

export function eventsRoutes(db: DB, auth: AuthService): Router {
  const router = Router();
  router.use('/api/events', requireSession(auth));

  router.get('/api/events', (req, res) => {
    const after = Number(req.query.after ?? 0);
    const roundId = req.query.roundId !== undefined ? Number(req.query.roundId) : undefined;
    res.json(recentEvents(db, Number.isFinite(after) ? after : 0, roundId));
  });

  router.get('/api/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 5000\n\n');

    let cursor = latestEventId(db); // only NEW events; the REST endpoint serves history
    const roundId = req.query.roundId !== undefined ? Number(req.query.roundId) : undefined;

    const poll = setInterval(() => {
      const rows = recentEvents(db, cursor, roundId);
      for (const row of rows) {
        cursor = row.id;
        res.write(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`);
      }
    }, SSE_POLL_MS);
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      res.end();
    });
  });

  return router;
}
