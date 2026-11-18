// Actions for the pronunciation checker.
//
// The client records the user's voice in the browser and transcribes it with
// the browser's speech recognizer; only the target sentence and the
// transcript reach the server. `recordAttempt` scores the attempt with a
// deterministic word alignment, asks the model for one short piece of
// Japanese feedback (best-effort), and stores the attempt in history.
//
// Notion export is opt-in per attempt: `saveToNotion` runs only when the
// user presses the save button on the result screen, and only then does
// the recording (sent as base64 in that one request) leave the device.
// The actual Notion calls live in privileged handlers (server/src/
// privileged.ts) because they need the host's notion-cli.

import { defineAction, z, type ActionsModule, type Ctx} from "@hatch/space-sdk";
import { PrivilegedContracts} from "@space/privileged";
import { asc, desc, eq} from "drizzle-orm";
import * as schema from "./schema";

const wordResult = z.object({
word: z.string(),
status: z.enum(["ok", "wrong", "missing"]),
heard: z.string().nullable(),
});

type WordResult = z.infer<typeof wordResult>;

const attemptShape = z.object({
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

type AttemptRow = typeof schema.attempts.$inferSelect;

function toAttempt(row: AttemptRow): z.infer<typeof attemptShape> {
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

function tokenize(text: string): string[] {
return text
.toLowerCase()
.replace(/[’‘]/g, "'")
.replace(/[^a-z0-9']/g, " ")
.split(/\s+/)
.filter((w) => w.length > 0);
}

/**
* Align target words to heard words via a longest-common-subsequence pass.
* Matched words are "ok"; leftover target words pair with leftover heard
* words in order as "wrong", or are "missing" when nothing was heard there.
*/
function diffWords(target: string, heard: string): { words: WordResult[]; score: number} {
const t = tokenize(target);
const h = tokenize(heard);
if (t.length === 0) return { words: [], score: 0};

// LCS table.
const dp: number[][] = Array.from({ length: t.length + 1}, () =>
new Array<number>(h.length + 1).fill(0),
);
for (let i = t.length - 1; i >= 0; i--) {
for (let j = h.length - 1; j >= 0; j--) {
const row = dp[i];
const next = dp[i + 1];
if (!row ||!next) continue;
row[j] = t[i] === h[j]? (next[j + 1]?? 0) + 1: Math.max(next[j]?? 0, row[j + 1]?? 0);
}
}
const matchedTarget = new Set<number>();
const matchedHeard = new Set<number>();
let i = 0;
let j = 0;
while (i < t.length && j < h.length) {
if (t[i] === h[j]) {
matchedTarget.add(i);
matchedHeard.add(j);
i++;
j++;
} else if ((dp[i + 1]?.[j]?? 0) >= (dp[i]?.[j + 1]?? 0)) {
i++;
} else {
j++;
}
}

const leftoverHeard = h.filter((_, idx) =>!matchedHeard.has(idx));
let leftoverIdx = 0;
const words: WordResult[] = t.map((word, idx) => {
if (matchedTarget.has(idx)) return { word, status: "ok", heard: word};
const heardWord = leftoverHeard[leftoverIdx];
if (heardWord!== undefined) {
leftoverIdx++;
return { word, status: "wrong", heard: heardWord};
}
return { word, status: "missing", heard: null};
});
const okCount = words.filter((w) => w.status === "ok").length;
return { words, score: Math.round((okCount / t.length) * 100)};
}

const feedbackSchema = z.object({ feedback_ja: z.string()});

// --- Notion destinations ---

const destinationShape = z.object({
pageId: z.string(),
title: z.string(),
url: z.string(),
path: z.string().nullable(),
isDefault: z.boolean(),
});

type Destination = z.infer<typeof destinationShape>;

async function loadDestinations(ctx: Ctx): Promise<Destination[]> {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.notionDestinations)
.orderBy(desc(schema.notionDestinations.isDefault), asc(schema.notionDestinations.title));
return rows.map((r) => ({
pageId: r.pageId,
title: r.title,
url: r.url,
path: r.path,
isDefault: r.isDefault === 1,
}));
}

const destinationsResponse = z.object({ destinations: z.array(destinationShape)});

export const Actions = {
listAttempts: defineAction({
description: "Lists past pronunciation-check attempts, newest first.",
request: z.object({
limit: z.number().int().positive().max(200).default(50),
}),
response: z.object({ attempts: z.array(attemptShape)}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const rows = await db
.select()
.from(schema.attempts)
.orderBy(desc(schema.attempts.id))
.limit(args.limit);
return { attempts: rows.map(toAttempt)};
},
}),

recordAttempt: defineAction({
description:
"Scores one pronunciation attempt (target sentence vs recognized transcript), stores it in history, and returns the per-word result.",
request: z.object({
target: z.string().min(1).max(500),
heard: z.string().max(1000),
}),
response: attemptShape,
async handler(ctx, args): Promise<z.infer<typeof attemptShape>> {
const { words, score} = diffWords(args.target, args.heard);

// Best-effort model feedback; the deterministic score stands without it.
let feedback: string | null = null;
const problems = words.filter((w) => w.status!== "ok");
try {
const result = await ctx.inference.complete(
`Target sentence: "${args.target}"\nRecognized transcript: "${args.heard}"\nScore: ${score}/100\nProblem words: ${
problems.length
? problems.map((w) => `"${w.word}" heard as ${w.heard? `"${w.heard}"`: "nothing"}`).join(", ")
: "none"
}`,
{
system:
"You are an English pronunciation coach for a Japanese learner. Give exactly one short, encouraging sentence of feedback in Japanese about this read-aloud attempt, naming the main thing to fix if there is one. Base it only on the word-level comparison given; do not invent phoneme-level detail the data cannot show.",
schema: feedbackSchema,
},
);
feedback = result.feedback_ja;
} catch {
feedback = null;
}

const db = ctx.db<typeof schema>();
const insertedRows = await db
.insert(schema.attempts)
.values({
target: args.target,
heard: args.heard,
score,
wordsJson: JSON.stringify(words),
feedback,
})
.returning();
const row = insertedRows[0];
if (!row) throw new Error("recordAttempt: insert returned no rows");
ctx.invalidateQueries();
return toAttempt(row);
},
}),

deleteAttempt: defineAction({
description: "Deletes one pronunciation-check attempt from history.",
request: z.object({ id: z.number().int().positive()}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx, args): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
await db.delete(schema.attempts).where(eq(schema.attempts.id, args.id));
ctx.invalidateQueries();
return { ok: true};
},
}),

clearAttempts: defineAction({
description: "Deletes all pronunciation-check history.",
request: z.object({}),
response: z.object({ ok: z.literal(true)}),
async handler(ctx): Promise<{ ok: true}> {
const db = ctx.db<typeof schema>();
await db.delete(schema.attempts);
ctx.invalidateQueries();
return { ok: true};
},
}),

listNotionDestinations: defineAction({
description: "Lists the cached Notion pages the user can pick as a save destination.",
request: z.object({}),
response: destinationsResponse,
async handler(ctx): Promise<z.infer<typeof destinationsResponse>> {
return { destinations: await loadDestinations(ctx)};
},
}),

searchNotionDestinations: defineAction({
description:
"Searches the user's Notion workspace for pages matching a query, caches them as save destinations, and returns the cached destination list.",
request: z.object({ query: z.string().min(1).max(100)}),
response: destinationsResponse,
privileged: [PrivilegedContracts.notionSearch],
async handler(ctx, args): Promise<z.infer<typeof destinationsResponse>> {
const { results} = await ctx.executePrivileged(PrivilegedContracts.notionSearch, {
query: args.query,
});
const db = ctx.db<typeof schema>();
const pages = results.filter((r) => r.type === "page");
if (pages.length > 0) {
const existing = await db.select().from(schema.notionDestinations);
const hasDefault = existing.some((r) => r.isDefault === 1);
for (const p of pages) {
// The TED page (the user's chosen home for these results) becomes
// the default the first time it is seen, until the user picks
// another default.
const makeDefault =!hasDefault && p.title === "TED";
await db
.insert(schema.notionDestinations)
.values({
pageId: p.id,
title: p.title,
url: p.url,
path: p.path,
isDefault: makeDefault? 1: 0,
updatedAt: new Date(),
})
.onConflictDoUpdate({
target: schema.notionDestinations.pageId,
set: { title: p.title, url: p.url, path: p.path, updatedAt: new Date()},
});
}
}
ctx.invalidateQueries();
return { destinations: await loadDestinations(ctx)};
},
}),

setDefaultNotionDestination: defineAction({
description: "Marks one cached Notion page as the default save destination.",
request: z.object({ pageId: z.string().min(1).max(64)}),
response: destinationsResponse,
async handler(ctx, args): Promise<z.infer<typeof destinationsResponse>> {
const db = ctx.db<typeof schema>();
await db.update(schema.notionDestinations).set({ isDefault: 0});
await db
.update(schema.notionDestinations)
.set({ isDefault: 1})
.where(eq(schema.notionDestinations.pageId, args.pageId));
ctx.invalidateQueries();
return { destinations: await loadDestinations(ctx)};
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
return { status: "error" as const, pageUrl: null, message: "対象の練習結果が見つかりませんでした。"};
}
if (attempt.notionPageUrl) {
return { status: "already_saved" as const, pageUrl: attempt.notionPageUrl, message: null};
}

const words = z.array(wordResult).parse(JSON.parse(attempt.wordsJson)) as WordResult[];
const problems = words.filter((w) => w.status!== "ok");
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
.map((w) => (w.heard? `${w.word}（「${w.heard}」と聞き取り）`: `${w.word}（聞き取れず）`))
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
c.status === "passed"? "通じた可能性あり": c.status === "check"? "要確認": "";
lines.push(
`- ${c.kindLabel}: ${flat(c.phrase)} — ${flat(c.detail)}${mark? `（${mark}）`: ""}`,
);
}
}
const content = lines.join("\n");

const mime = (args.audioMimeType?? "").split(";")[0]?.trim()?? "";
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
return { status: "saved" as const, pageUrl: saved.pageUrl, message: null};
} catch (e) {
return {
status: "error" as const,
pageUrl: null,
message: `Notionへの保存に失敗しました。${e instanceof Error? `（${e.message.slice(0, 160)}）`: ""}`,
};
}
},
}),
} satisfies ActionsModule;
