-- The admin page (/admin/, behind Cloudflare Access): granted licenses, what admins did, download
-- counts and problems worth a look.

-- How a license came about: bought through the payment provider, or given from the admin page.
ALTER TABLE licenses ADD COLUMN source TEXT NOT NULL DEFAULT 'purchase';
-- Why it was given, revoked or reissued, in the admin's words.
ALTER TABLE licenses ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- A reissued key (the old one leaked): the license that replaced this one, which took over its
-- order, purchase date and account. Counts skip replaced licenses, so a reissue isn't a second sale.
ALTER TABLE licenses ADD COLUMN replaced_by TEXT;
-- Licenses made by scripts/grant-license.mjs before this had no order.
UPDATE licenses SET source = 'grant' WHERE order_id IS NULL;

-- Every change made from the admin page, by the Access-verified email that made it.
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  license_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX admin_log_license ON admin_log(license_id);

-- Clicks on /download/<platform>, as daily totals. Nothing about who downloaded: `source` is the
-- page of this site the button was on, or the other site's host name, or '' when not known.
CREATE TABLE download_counts (
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, platform, version, source)
);

-- Things that went wrong and need a look: an email the provider refused ('email'), a webhook that
-- failed ('webhook'), a rate limit someone ran into ('rate_limit'). Kept 90 days.
CREATE TABLE problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX problems_at ON problems(at);
