-- Only text explicitly submitted from the in-app report form. No account, budget, conversation,
-- attachment, session or device identifiers. Daily cleanup removes reports after 90 days.
CREATE TABLE assistant_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  reply TEXT NOT NULL CHECK (length(reply) BETWEEN 1 AND 4000),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000)
);
CREATE INDEX assistant_reports_created_at ON assistant_reports(created_at);
