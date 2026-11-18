// Shared shapes for the server actions.
//
// The attempt row is the one piece of data all three server features
// touch: scoring creates it, history lists and deletes it, and the
// Notion export reads it and marks it saved. The Zod shapes and the
// DB-row → response conversion therefore live here, in one place, so
// a change to the attempt shape is made once instead of being kept in
// sync across the feature modules.

import { z } from "@hatch/space-sdk";
import type * as schema from "../schema";

export const wordResult = z.object({
  word: z.string(),
  status: z.enum(["ok", "wrong", "missing"]),
  heard: z.string().nullable(),
});

export type WordResult = z.infer<typeof wordResult>;

export const attemptShape = z.object({
  id: z.number(),
  target: z.string(),
  heard: z.string(),
  score: z.number(),
  words: z.array(wordResult),
  feedback: z.string().nullable(),
  created_at: z.string(),
  notion_page_url: z.string().nullable(),
  notion_parent_title: z.string().nullable(),
});

export type Attempt = z.infer<typeof attemptShape>;

type AttemptRow = typeof schema.attempts.$inferSelect;

export function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    target: row.target,
    heard: row.heard,
    score: row.score,
    words: z.array(wordResult).parse(JSON.parse(row.wordsJson)),
    feedback: row.feedback,
    created_at: row.createdAt.toISOString(),
    notion_page_url: row.notionPageUrl,
    notion_parent_title: row.notionParentTitle,
  };
}
