CREATE TABLE day_cache (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, date)
);
CREATE INDEX day_cache_fetched_at ON day_cache(fetched_at);
