-- Download clicks by kind, so the admin page counts customers apart from everything else:
-- 'person' (a browser that came from a page or a link), 'team' (a browser that opened the admin
-- page) and 'bot' (crawlers, scripts, headless and AI agents' browsers, and bare requests with
-- neither a referrer nor a browser's fetch metadata). The kind is part of the key, so the table
-- is made again.
CREATE TABLE download_counts_new (
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, platform, version, source, kind)
);
-- Before this, crawlers weren't counted at all, and what was counted without a referrer were the
-- launch-day checks of the download links, so those go down as bots.
INSERT INTO download_counts_new (day, platform, version, source, kind, count)
  SELECT day, platform, version, source, CASE source WHEN '' THEN 'bot' ELSE 'person' END, count FROM download_counts;
DROP TABLE download_counts;
ALTER TABLE download_counts_new RENAME TO download_counts;
