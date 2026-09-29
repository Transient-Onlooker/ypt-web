CREATE TABLE group_access_cache (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL,
  country_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, group_id)
);
CREATE INDEX group_access_cache_expiry ON group_access_cache(expires_at);
