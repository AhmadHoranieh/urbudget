-- Purchase tokens stay on the server; never log or expose them in account responses.
CREATE TABLE google_purchases (
  token_hash TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  account_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('license', 'sync')),
  state TEXT NOT NULL,
  expires_at TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX google_purchases_user ON google_purchases(user_id);
CREATE INDEX google_purchases_refresh ON google_purchases(checked_at);
