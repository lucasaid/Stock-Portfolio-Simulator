import type { DB } from './connection.js';

export type EventLevel = 'info' | 'warn' | 'error';

export function logEvent(db: DB, level: EventLevel, kind: string, message: string, roundId: number | null = null): void {
  db.prepare('INSERT INTO event_log (round_id, level, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(roundId, level, kind, message, new Date().toISOString());
}
