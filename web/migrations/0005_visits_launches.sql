-- Page views of urbudget.app as daily totals. The site's own script sends one beacon per page:
-- the page, and where the visitor came from (a link's ?ref= tag as ref:<tag>, the other site's host
-- name, 'internal' from another page of this site, or '' when the browser didn't say). The kind is
-- 'person', 'team' or 'bot', as for downloads. Nothing about who is kept.
CREATE TABLE page_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, path, source, kind)
);

-- App launches as daily totals per system, architecture and version. Copies from 1.0.2 on ask
-- urbudget.app for updates a few seconds after they start (and once a day while left open), so
-- each ask is about one launch. Store copies don't ask; the Store updates them.
CREATE TABLE app_launches (
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  version TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, platform, arch, version)
);
