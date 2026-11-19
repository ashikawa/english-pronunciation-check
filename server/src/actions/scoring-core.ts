// Pure scoring core: tokenization, word alignment, and best-candidate
// selection. No I/O, no SDK, no database — everything here is a
// deterministic function of its inputs, which is exactly what makes it
// unit-testable (see server/tests/actions/scoring-core.test.ts).
// `scoring.ts` wraps these
// functions with the action handler (feedback generation + storage).

import type { WordResult } from "./shared";

export function tokenize(text: string): string[] {
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
export function diffWords(
  target: string,
  heard: string,
): { words: WordResult[]; score: number } {
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

export interface ScoredAttempt {
  /** The transcript that was scored (the winning candidate, verbatim). */
  heard: string;
  words: WordResult[];
  score: number;
}

/**
 * Score an attempt against every distinct transcript the recognizer
 * returned and keep the best. The primary transcript is considered
 * first, so a tie keeps the recognizer's own best guess and the result
 * only ever improves on single-candidate scoring — a word the learner
 * said is not counted as a mistake just because the first guess missed
 * it. Candidates are de-duplicated case-insensitively and capped at 32,
 * matching the `recordAttempt` request limits.
 */
export function selectBestCandidate(
  target: string,
  heard: string,
  heardCandidates?: string[],
): ScoredAttempt {
  const candidateTexts: string[] = [];
  const seenCandidates = new Set<string>();
  for (const raw of [heard, ...(heardCandidates ?? [])]) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    candidateTexts.push(t);
    if (candidateTexts.length >= 32) break;
  }
  if (candidateTexts.length === 0) candidateTexts.push(heard);
  let bestHeard = candidateTexts[0] ?? heard;
  let best = diffWords(target, bestHeard);
  for (let idx = 1; idx < candidateTexts.length; idx++) {
    const cand = candidateTexts[idx];
    if (!cand) continue;
    const scored = diffWords(target, cand);
    if (scored.score > best.score) {
      best = scored;
      bestHeard = cand;
    }
  }
  return { heard: bestHeard, words: best.words, score: best.score };
}
