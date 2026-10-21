-- What happens on the API each day, as totals: nothing about who. `name` is what happened and
-- `detail` which kind ('' when there's only one):
--   email           an email Resend accepted ('sign-in code', 'license key')
--   sign_in         a sign-in that went through ('web', 'desktop', or 'link': the app opening the
--                   website signed in)
--   activation      a key entered in the app ('ok', 'unknown' key, 'inactive': refunded or revoked,
--                   'malformed': not shaped like a key)
--   checkout        a checkout opened at the payment provider ('license', 'sync')
--   sync_upload     a budget uploaded to sync ('ok', or 'conflict': another device synced first)
--   account_deleted an account its owner deleted
--   cleanup         the daily clean-up ran
CREATE TABLE events (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL,
  PRIMARY KEY (day, name, detail)
);

-- When a license was first activated, and when it was refunded. Earlier activations only have
-- last_activated_at, which is also the first one for a key activated once; earlier refunds have no date.
ALTER TABLE licenses ADD COLUMN first_activated_at TEXT;
ALTER TABLE licenses ADD COLUMN refunded_at TEXT;
UPDATE licenses SET first_activated_at = last_activated_at WHERE activations = 1;
