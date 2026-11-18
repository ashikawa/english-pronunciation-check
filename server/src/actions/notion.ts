// Notion export: search destination pages and save a scored attempt.
//
// Export is opt-in per attempt: `saveToNotion` runs only when the user
// presses the save button on the result screen, and only then does the
// recording (sent as base64 in that one request) leave the device. The
// actual Notion calls live in privileged handlers (server/src/
// privileged.ts) because they need the host's notion-cli.
//
// The save-destination list is NOT stored server-side: it is a
// per-device picker convenience, so the client keeps it in
// localStorage. `searchNotionPages` only proxies one Notion search and
// returns the matches; the client merges them into its local list.

import { defineAction, z } from "@hatch/space-sdk";
import { PrivilegedContracts } from "@space/privileged";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { wordResult, type WordResult } from "./shared";

const notionPageShape = z.object({
  pageId: z.string(),
  title: z.string(),
  url: z.string(),
  path: z.string().nullable(),
});

const notionPagesResponse = z.object({ pages: z.array(notionPageShape) });

export const NotionActions = {
  searchNotionPages: defineAction({
    description:
      "Searches the user's Notion workspace for pages matching a query and returns the matches. Nothing is stored server-side; the client merges the results into its localStorage destination list.",
    request: z.object({ query: z.string().min(1).max(100) }),
    response: notionPagesResponse,
    privileged: [PrivilegedContracts.notionSearch],
    async handler(ctx, args): Promise<z.infer<typeof notionPagesResponse>> {
      const { results } = await ctx.executePrivileged(PrivilegedContracts.notionSearch, {
        query: args.query,
      });
      return {
        pages: results
          .filter((r) => r.type === "page")
          .map((r) => ({ pageId: r.id, title: r.title, url: r.url, path: r.path })),
      };
    },
  }),

  saveToNotion: defineAction({
    description:
      "Saves one scored attempt to Notion as a new page under the chosen parent page (or as a private draft), attaching the recording when audio is provided. Runs only on the user's explicit save action.",
    request: z.object({
      attemptId: z.number().int().positive(),
      parentPageId: z.string().max(64).nullable(),
      parentTitle: z.string().max(200).nullable(),
      audioBase64: z.string().max(30_000_000).nullable(),
      audioMimeType: z.string().max(100).nullable(),
      candidates: z
        .array(
          z.object({
            kindLabel: z.string().max(20),
            phrase: z.string().max(200),
            detail: z.string().max(200),
            status: z.enum(["passed", "check"]).nullable(),
          }),
        )
        .max(100),
    }),
    response: z.object({
      status: z.enum(["saved", "already_saved", "error"]),
      pageUrl: z.string().nullable(),
      message: z.string().nullable(),
    }),
    privileged: [PrivilegedContracts.notionSaveResult],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.id, args.attemptId))
        .limit(1);
      const attempt = rows[0];
      if (!attempt) {
        return { status: "error" as const, pageUrl: null, message: "対象の練習結果が見つかりませんでした。" };
      }
      if (attempt.notionPageUrl) {
        return { status: "already_saved" as const, pageUrl: attempt.notionPageUrl, message: null };
      }

      const words = z.array(wordResult).parse(JSON.parse(attempt.wordsJson)) as WordResult[];
      const problems = words.filter((w) => w.status !== "ok");
      const dateFmt = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const parts = Object.fromEntries(
        dateFmt.formatToParts(attempt.createdAt).map((p) => [p.type, p.value]),
      );
      const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
      const title = `英語発音チェック結果（${stamp}）`;

      const flat = (s: string) => s.replace(/\s+/g, " ").trim();
      const lines: string[] = [
        `- スコア: ${attempt.score} / 100点`,
        `- お手本の英文: ${flat(attempt.target)}`,
        `- 認識された文: ${flat(attempt.heard)}`,
      ];
      if (problems.length > 0) {
        lines.push(
          `- 要確認の単語: ${problems
            .map((w) => (w.heard ? `${w.word}（「${w.heard}」と聞き取り）` : `${w.word}（聞き取れず）`))
            .join("、")}`,
        );
      } else {
        lines.push("- 要確認の単語: なし（全単語が認識されました）");
      }
      if (attempt.feedback) lines.push(`- フィードバック: ${flat(attempt.feedback)}`);
      if (args.candidates.length > 0) {
        lines.push("", "## 音の変化の候補（綴りからの推定）", "");
        for (const c of args.candidates) {
          const mark =
            c.status === "passed" ? "通じた可能性あり" : c.status === "check" ? "要確認" : "";
          lines.push(
            `- ${c.kindLabel}: ${flat(c.phrase)} — ${flat(c.detail)}${mark ? `（${mark}）` : ""}`,
          );
        }
      }
      const content = lines.join("\n");

      const mime = (args.audioMimeType ?? "").split(";")[0]?.trim() ?? "";
      const ext =
        mime === "audio/mp4"
          ? "m4a"
          : mime === "audio/ogg"
            ? "ogg"
            : mime === "audio/mpeg"
              ? "mp3"
              : "webm";
      const audioFilename = args.audioBase64
        ? `recording-${stamp.replace(/[:]/g, "-")}.${ext}`
        : null;

      try {
        const saved = await ctx.executePrivileged(PrivilegedContracts.notionSaveResult, {
          title,
          content,
          parentPageId: args.parentPageId,
          audioBase64: args.audioBase64,
          audioMimeType: args.audioMimeType,
          audioFilename,
        });
        await db
          .update(schema.attempts)
          .set({
            notionPageId: saved.pageId,
            notionPageUrl: saved.pageUrl,
            notionParentTitle: args.parentTitle,
            notionSavedAt: new Date(),
          })
          .where(eq(schema.attempts.id, args.attemptId));
        ctx.invalidateQueries();
        return { status: "saved" as const, pageUrl: saved.pageUrl, message: null };
      } catch (e) {
        return {
          status: "error" as const,
          pageUrl: null,
          message: `Notionへの保存に失敗しました。${e instanceof Error ? `（${e.message.slice(0, 160)}）` : ""}`,
        };
      }
    },
  }),
};
