CREATE TABLE debug_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'cortex',
  direction TEXT NOT NULL,
  method TEXT,
  url TEXT NOT NULL,
  status INTEGER,
  headers TEXT,
  body TEXT,
  duration_ms INTEGER
);
