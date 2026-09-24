CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  encrypted_jwt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE timers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','starting','running','stopping','paused','uncertain')),
  subject TEXT,
  started_at INTEGER,
  origin TEXT CHECK (origin IN ('web','app')),
  revision INTEGER NOT NULL DEFAULT 0,
  pending_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE operations (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, id)
);
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_limits_expiry ON login_limits(expires_at);
