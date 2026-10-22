-- App Store subscriptions to Sync: one row per original transaction, which stays the same through
-- renewals. Everything here comes from data Apple signed; none of it is a credential.
CREATE TABLE apple_subscriptions (
  original_transaction_id TEXT PRIMARY KEY,
  -- Kept without an account after deletion, so another account can't claim the subscription.
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- The appAccountToken the purchase was made with, or '' when Apple sent none.
  app_account_token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('Production', 'Sandbox')),
  -- The newest transaction known: its id, purchase time and when Apple signed it (milliseconds).
  transaction_id TEXT NOT NULL,
  purchased_at INTEGER NOT NULL,
  signed_at INTEGER NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  -- From the newest renewal info: auto-renew on (1) or off (0), billing retry and grace period.
  auto_renew INTEGER,
  billing_retry INTEGER NOT NULL DEFAULT 0,
  grace_until TEXT,
  renewal_signed_at INTEGER,
  -- Bumped by every write, so concurrent notifications can't overwrite each other.
  revision INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX apple_subscriptions_user ON apple_subscriptions(user_id);
