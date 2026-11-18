import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per completed pronunciation check. The recording itself is never
// uploaded; only the target sentence, the recognized transcript, the score
// and the per-word results are kept.
export const attempts = sqliteTable("attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  target: text("target").notNull(),
  heard: text("heard").notNull(),
  score: integer("score").notNull(),
  // JSON: [{ word, status: "ok" | "wrong" | "missing", heard: string | null }]
  wordsJson: text("words_json").notNull(),
  feedback: text("feedback"),
  // Notion export state, set only when the user explicitly saves this
  // attempt (with its recording) to Notion from the result screen.
  notionPageId: text("notion_page_id"),
  notionPageUrl: text("notion_page_url"),
  notionParentTitle: text("notion_parent_title"),
  notionSavedAt: integer("notion_saved_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Note: the Notion save-destination list is intentionally NOT a table.
// It is a per-device picker convenience, so the client keeps it in
// localStorage; the server only proxies Notion searches on demand.
