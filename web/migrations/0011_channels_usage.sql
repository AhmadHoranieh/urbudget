-- Copies of the app in use, as daily totals with nothing about which copy. The app keeps the days
-- it was last counted on the device and says only what's new: its first opening ever ('install'),
-- its first today ('day'), this week ('week', Monday to Sunday, UTC) and this month ('month').
-- A week's total of 'week' is then the copies used that week, and so on. `cohort` (only on 'week')
-- is the Monday of the week the copy was first opened, shared by every copy opened that week, or
-- '' for one in use before counting began; it gives how many came back. `channel` is 'direct'
-- (an installer from urbudget.app or GitHub) or 'store' (Microsoft Store).
CREATE TABLE app_usage (
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  cohort TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL,
  PRIMARY KEY (day, platform, channel, version, kind, cohort)
);

-- GitHub's running download count of each file on the repository's releases, as last seen each
-- day (the hourly cron). A day's downloads are the rise from the day before.
CREATE TABLE github_downloads (
  day TEXT NOT NULL,
  tag TEXT NOT NULL,
  asset TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, tag, asset)
);

-- Microsoft Store numbers per day from Partner Center's analytics API: 'acquisitions' (people who
-- got the app) and 'installs' (successful installs). Fetched once a day for the last 30 days,
-- since Partner Center fills in recent days late.
CREATE TABLE store_counts (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);

-- When each outside source of numbers ('github', 'store') was last asked, last answered, and what
-- went wrong the last time it didn't.
CREATE TABLE channel_fetches (
  source TEXT PRIMARY KEY,
  tried_at TEXT NOT NULL,
  ok_at TEXT,
  error TEXT NOT NULL DEFAULT ''
);
