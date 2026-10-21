-- Accounts are optional: an email and nothing else. Times are ISO 8601 UTC strings.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  -- The account's customer id at the payment provider (Polar today).
  billing_customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

-- One pending sign-in code per address; only its hash is stored.
CREATE TABLE login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A web cookie or a desktop token; `id` is the SHA-256 of the secret the client holds.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'desktop', 'link')),
  device_name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Lifetime licenses. Bought with or without an account; `email` is where the key was sent.
CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'refunded', 'revoked')),
  -- The provider's order, and the checkout it came from (the success page looks it up by that).
  order_id TEXT UNIQUE,
  checkout_id TEXT,
  activations INTEGER NOT NULL DEFAULT 0,
  last_activated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX licenses_user ON licenses(user_id);
CREATE INDEX licenses_email ON licenses(email);
CREATE INDEX licenses_checkout ON licenses(checkout_id);

-- Subscriptions to the $2/month sync plan, mirrored from the provider's webhooks.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TEXT,
  cancel_at TEXT,
  updated_at TEXT NOT NULL,
  -- When the provider made the change that wrote this row, so late deliveries can't roll it back.
  event_at TEXT NOT NULL
);
CREATE INDEX subscriptions_user ON subscriptions(user_id);

-- The salt and passphrase check for end-to-end encrypted sync. No key ever reaches the server.
CREATE TABLE sync_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  key_check TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per synced budget. Each upload is a new R2 object (`object_key`); the row moves to it
-- only if the revision is still the one the upload replaced, so racing devices can't mix bytes.
CREATE TABLE sync_budgets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, budget_id)
);

-- Provider webhooks already handled, so retries are harmless.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Fixed-window counters for rate limits (sign-in codes, activations).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
