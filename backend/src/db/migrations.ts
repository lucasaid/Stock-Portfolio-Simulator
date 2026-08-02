export const migrations: string[] = [
  `
CREATE TABLE rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  starting_balance_cents INTEGER NOT NULL,
  cash_cents INTEGER NOT NULL,
  profit_goal_cents INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE config_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  changed_by TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE symbols (
  symbol TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  name TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE price_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  ts TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_price_bars_symbol_ts ON price_bars(symbol, ts);
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_basis_cents INTEGER NOT NULL,
  stop_loss_price REAL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  client_order_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  requested_cents INTEGER,
  quantity REAL,
  status TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price_aud REAL NOT NULL,
  gross_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  executed_at TEXT NOT NULL
);
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  ref_order_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  ts TEXT NOT NULL,
  cash_cents INTEGER NOT NULL,
  holdings_cents INTEGER NOT NULL,
  equity_cents INTEGER NOT NULL
);
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  ts TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  tokens_used INTEGER,
  status TEXT NOT NULL
);
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  checkin_id INTEGER REFERENCES checkins(id),
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  day TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  narrative TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(round_id, day)
);
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
];
