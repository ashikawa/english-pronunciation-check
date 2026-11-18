DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  heard TEXT NOT NULL,
  score INTEGER NOT NULL,
  words_json TEXT NOT NULL,
  feedback TEXT,
  created_at INTEGER NOT NULL
);
