// Scoring: score one pronunciation attempt and store it in history.
//
// The client records the user's voice in the browser and transcribes it
// with the browser's speech recognizer; only the target sentence and the
// transcript reach the server — the recording itself is never sent for
// scoring. The recognizer is asked for several alternative transcripts
// (maxAlternatives); the client forwards those candidates and
// `recordAttempt` scores the attempt against the candidate closest to
// the target sentence, asks the model for one short piece of Japanese
// feedback (best-effort), and stores the attempt in history. No
// phoneme-level or external pronunciation evaluation is used: the match
// is improved only within the candidates the browser itself returned.
//
// The deterministic scoring itself (tokenize / diffWords /
// selectBestCandidate) lives in scoring-core.ts as pure functions with
// unit tests; this module is only the action wrapper around them.

import { defineAction, z } from "@hatch/space-sdk";
import * as schema from "../schema";
import { selectBestCandidate } from "./scoring-core";
import { attemptShape, toAttempt, type Attempt } from "./shared";

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
      const { heard, words, score } = selectBestCandidate(
        args.target,
        args.heard,
        args.heardCandidates,
      );

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
