import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDb(path = ':memory:'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
