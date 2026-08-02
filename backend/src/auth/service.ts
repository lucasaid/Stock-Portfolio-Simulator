import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db/connection.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthService {
  constructor(private db: DB) {}

  hasUsers(): boolean {
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return c > 0;
  }

  async createUser(username: string, password: string): Promise<number> {
    if (this.hasUsers()) throw new Error('single user only: a user already exists');
    const hash = await argon2.hash(password);
    const r = this.db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hash, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  async verifyLogin(username: string, password: string): Promise<number | null> {
    const row = this.db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as
      | { id: number; password_hash: string }
      | undefined;
    if (!row) return null;
    return (await argon2.verify(row.password_hash, password)) ? row.id : null;
  }

  createSession(userId: number, ttlMs: number = SESSION_TTL_MS): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db
      .prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, expiresAt, new Date().toISOString());
    return { token, expiresAt };
  }

  validateSession(token: string): { userId: number } | null {
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) as
      | { user_id: number; expires_at: string }
      | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return { userId: row.user_id };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  async changePassword(userId: number, current: string, next: string): Promise<void> {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      | { password_hash: string }
      | undefined;
    if (!row || !(await argon2.verify(row.password_hash, current))) {
      throw new Error('current password is incorrect');
    }
    const hash = await argon2.hash(next);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // force re-login everywhere
  }

  username(userId: number): string | null {
    const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
      | { username: string }
      | undefined;
    return row?.username ?? null;
  }
}
