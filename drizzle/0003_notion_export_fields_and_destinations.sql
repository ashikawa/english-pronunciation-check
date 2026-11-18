ALTER TABLE attempts ADD COLUMN notion_page_id TEXT;
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN notion_page_url TEXT;
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN notion_parent_title TEXT;
--> statement-breakpoint
ALTER TABLE attempts ADD COLUMN notion_saved_at INTEGER;
--> statement-breakpoint
CREATE TABLE notion_destinations (
  page_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
