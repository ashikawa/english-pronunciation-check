// Scoring: score one pronunciation attempt and store it in history.
//
// The client records the user's voice in the browser and transcribes it
// with the browser's speech recognizer; only the target sentence and the
// transcript reach the server — the recording itself is never sent for
// scoring. The recognizer is asked for several alternative transcripts
// (maxAlternatives); the client forwards those candidates and
// `recordAttempt` scores the attempt against the candidate closest to
// the target sentence, with a deterministic word alignment, asks the
// model for one short piece of Japanese feedback (best-effort), and
// stores the attempt in history. No phoneme-level or external
// pronunciation evaluation is used: the match is improved only within
// the candidates the browser itself returned.

import { defineAction, z } from "@hatch/space-sdk";
import * as schema from "../schema";
import { attemptShape, toAttempt, type Attempt, type WordResult } from "./shared";

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
function diffWords(target: string, heard: string): { words: WordResult[]; score: number } {
  const t = tokenize(target);
  const h = tokenize(heard);
  if (t.length === 0) return { words: [], score: 0 };

  // LCS table.
  const dp: number[][] = Array.from({ length: t.length + 1 }, () =>
    new Array<number>(h.length + 1).fill(0),
  );
  for (let i = t.length - 1; i >= 0; i--) {
    for (let j = h.length - 1; j >= 0; j--) {
      const row = dp[i];
      const next = dp[i + 1];
      if (!row || !next) continue;
      row[j] = t[i] === h[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
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
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }

  const leftoverHeard = h.filter((_, idx) => !matchedHeard.has(idx));
  let leftoverIdx = 0;
  const words: WordResult[] = t.map((word, idx) => {
    if (matchedTarget.has(idx)) return { word, status: "ok", heard: word };
    const heardWord = leftoverHeard[leftoverIdx];
    if (heardWord !== undefined) {
      leftoverIdx++;
      return { word, status: "wrong", heard: heardWord };
    }
    return { word, status: "missing", heard: null };
  });
  const okCount = words.filter((w) => w.status === "ok").length;
  return { words, score: Math.round((okCount / t.length) * 100) };
}

const feedbackSchema = z.object({ feedback_ja: z.string() });

export const ScoringActions = {
  recordAttempt: defineAction({
    description:
      "Scores one pronunciation attempt (target sentence vs the recognized transcript closest to it among the browser's alternative candidates), stores it in history, and returns the per-word result.",
    request: z.object({
      target: z.string().min(1).max(500),
      heard: z.string().max(1000),
      // Alternative transcripts the browser recognizer returned for the
      // same take (full-sentence combinations of its per-segment
      // alternatives, best guess first). Optional: older clients and
      // browsers that return a single alternative omit it, and scoring
      // then uses `heard` alone, exactly as before.
      heardCandidates: z.array(z.string().min(1).max(1000)).max(32).optional(),
    }),
    response: attemptShape,
    async handler(ctx, args): Promise<Attempt> {
      // Pick the candidate closest to the target: score every distinct
      // transcript with the same deterministic alignment and keep the
      // best. The primary transcript is considered first, so a tie keeps
      // the recognizer's own best guess and the result only ever improves
      // on single-candidate scoring — a word the learner said is not
      // counted as a mistake just because the first guess missed it.
      const candidateTexts: string[] = [];
      const seenCandidates = new Set<string>();
      for (const raw of [args.heard, ...(args.heardCandidates ?? [])]) {
        const t = raw.trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        candidateTexts.push(t);
        if (candidateTexts.length >= 32) break;
      }
      if (candidateTexts.length === 0) candidateTexts.push(args.heard);
      let heard = candidateTexts[0] ?? args.heard;
      let best = diffWords(args.target, heard);
      for (let idx = 1; idx < candidateTexts.length; idx++) {
        const cand = candidateTexts[idx];
        if (!cand) continue;
        const scored = diffWords(args.target, cand);
        if (scored.score > best.score) {
          best = scored;
          heard = cand;
        }
      }
      const { words, score } = best;

      // Best-effort model feedback; the deterministic score stands without it.
      let feedback: string | null = null;
      const problems = words.filter((w) => w.status !== "ok");
      try {
        const result = await ctx.inference.complete(
          `Target sentence: "${args.target}"\nRecognized transcript: "${heard}"\nScore: ${score}/100\nProblem words: ${
            problems.length
              ? problems.map((w) => `"${w.word}" heard as ${w.heard ? `"${w.heard}"` : "nothing"}`).join(", ")
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
          heard,
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
};
