-- A reset invalidates every request encrypted with an earlier key. Generation zero
-- preserves existing clients until their account's first passphrase reset.
ALTER TABLE sync_keys ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- These provider identifiers prevent delayed callbacks from undoing deletion/refunds.
-- They contain no sign-in credentials or budget contents.
CREATE TABLE deleted_billing_customers (
  customer_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
-- Recurring purchases cannot attach between cancellation and account deletion.
-- A token distinguishes overlapping attempts; a stale attempt can be retried.
CREATE TABLE account_deletions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE TABLE refunded_orders (
  order_id TEXT PRIMARY KEY,
  refunded_at TEXT NOT NULL
);
INSERT INTO refunded_orders (order_id, refunded_at)
SELECT order_id, COALESCE(refunded_at, created_at) FROM licenses
WHERE status = 'refunded' AND order_id IS NOT NULL;

-- Database changes commit before object storage cleanup. A durable queue makes
-- failed cleanup retryable, including rows removed by account-deletion cascades.
CREATE TABLE sync_object_garbage (
  object_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sync_budgets_object ON sync_budgets(object_key);
CREATE TRIGGER sync_budget_deleted AFTER DELETE ON sync_budgets BEGIN
  INSERT OR IGNORE INTO sync_object_garbage (object_key) VALUES (OLD.object_key);
END;
CREATE TRIGGER sync_budget_replaced AFTER UPDATE OF object_key ON sync_budgets
WHEN OLD.object_key <> NEW.object_key BEGIN
  INSERT OR IGNORE INTO sync_object_garbage (object_key) VALUES (OLD.object_key);
END;

-- Also serves as a short cross-request refresh lease and retry backoff.
ALTER TABLE google_purchases ADD COLUMN refresh_after TEXT;
