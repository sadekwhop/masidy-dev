CREATE TABLE IF NOT EXISTS team_keys (
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  owner TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_usage (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  cost INTEGER,
  ms INTEGER,
  ok INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS team_payments (
  event_id TEXT PRIMARY KEY,
  key_id TEXT,
  credits INTEGER,
  created_at INTEGER
);
