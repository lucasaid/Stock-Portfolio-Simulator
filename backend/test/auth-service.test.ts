import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { openDb, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

describe('AuthService', () => {
  let db: DB;
  let auth: AuthService;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    auth = new AuthService(db);
  });

  it('creates a user with an argon2 hash and reports hasUsers', async () => {
    expect(auth.hasUsers()).toBe(false);
    await auth.createUser('chris', 'hunter22');
    expect(auth.hasUsers()).toBe(true);
    const row = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$argon2/);
  });

  it('enforces single-user (spec §6.1)', async () => {
    await auth.createUser('chris', 'hunter22');
    await expect(auth.createUser('mallory', 'x')).rejects.toThrow(/single user/);
  });

  it('verifies logins', async () => {
    await auth.createUser('chris', 'hunter22');
    expect(await auth.verifyLogin('chris', 'hunter22')).toEqual(expect.any(Number));
    expect(await auth.verifyLogin('chris', 'wrong')).toBeNull();
    expect(await auth.verifyLogin('nobody', 'hunter22')).toBeNull();
  });

  it('creates, validates, and deletes sessions', async () => {
    const userId = (await auth.createUser('chris', 'hunter22'))!;
    const { token } = auth.createSession(userId);
    expect(auth.validateSession(token)).toEqual({ userId });
    auth.deleteSession(token);
    expect(auth.validateSession(token)).toBeNull();
  });

  it('rejects expired sessions and cleans them up', async () => {
    const userId = (await auth.createUser('chris', 'hunter22'))!;
    const { token } = auth.createSession(userId, -1000); // already expired
    expect(auth.validateSession(token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
  });

  it('changes password only with the correct current password', async () => {
    const userId = (await auth.createUser('chris', 'hunter22'))!;
    await expect(auth.changePassword(userId, 'wrong', 'newpass')).rejects.toThrow(/current password/);
    await auth.changePassword(userId, 'hunter22', 'newpass');
    expect(await auth.verifyLogin('chris', 'newpass')).toBe(userId);
    expect(await auth.verifyLogin('chris', 'hunter22')).toBeNull();
  });

  it('looks up usernames by id', async () => {
    const userId = await auth.createUser('chris', 'hunter22');
    expect(auth.username(userId)).toBe('chris');
    expect(auth.username(999)).toBeNull();
  });
});
