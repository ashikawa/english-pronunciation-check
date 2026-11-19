// --- Sound-change candidates (連結 / 消失 / フラップ / 弱形) ---
// Heuristic detection from spelling only, following the teacher's four
// basic patterns. These are candidates to check while shadowing, NOT a
// phoneme-level judgement: whether the sound actually changed cannot be
// verified from the word-level transcript.

export type ChangeKind = "liaison" | "elision" | "flap" | "weak";

export const KIND_META: Record<ChangeKind, { label: string; color: string; bg: string }> = {
  liaison: { label: "連結", color: "var(--cand-liaison)", bg: "var(--cand-liaison-bg)" },
  elision: { label: "消失", color: "var(--cand-elision)", bg: "var(--cand-elision-bg)" },
  flap: { label: "フラップ", color: "var(--cand-flap)", bg: "var(--cand-flap-bg)" },
  weak: { label: "弱形", color: "var(--cand-weak)", bg: "transparent" },
};
export const KIND_ORDER: ChangeKind[] = ["liaison", "elision", "flap", "weak"];

export interface Tok {
  raw: string;
  norm: string;
  start: number;
  end: number;
}

export interface Candidate {
  kind: ChangeKind;
  tokenIndexes: number[];
  charMarks: { token: number; from: number; to: number }[];
  phrase: string;
  detail: string;
}

const VOWEL_LETTERS = new Set(["a", "e", "i", "o", "u"]);
const PLOSIVES = new Set(["p", "b", "k", "g", "t", "d"]);
// Function words typically pronounced very weakly (弱形).
const WEAK_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "for", "of", "to", "at", "in", "on",
  "from", "as", "him", "her", "his", "them", "us", "he", "she", "we", "you",
  "can", "could", "shall", "should", "will", "would", "do", "does", "have",
  "has", "had", "are", "am", "is", "was", "were",
]);

export function parseTokens(text: string): Tok[] {
  const toks: Tok[] = [];
  const re = /[A-Za-z0-9'’]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    toks.push({
      raw: m[0],
      norm: m[0].toLowerCase().replace(/’/g, "'"),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return toks;
}

function startsWithVowelSound(w: string): boolean {
  if (/^(hour|honest|honor|honour|heir)/.test(w)) return true; // silent h
  if (/^(one|once|uni|use|usu|eu)/.test(w)) return false; // /w/ or /j/ onset
  return VOWEL_LETTERS.has(w[0] ?? "");
}

/** Final pronounced consonant of a word, skipping a silent trailing "e"
 *  (take → k, like → k), mirroring the teacher's examples. */
function effectiveEnd(w: string): { letter: string; index: number } {
  const last = w.length - 1;
  if (w.length >= 2 && w.endsWith("e") && !VOWEL_LETTERS.has(w[last - 1] ?? "")) {
    return { letter: w[last - 1] ?? "", index: last - 1 };
  }
  return { letter: w[last] ?? "", index: last };
}

export function findCandidates(toks: Tok[]): Candidate[] {
  const out: Candidate[] = [];
  toks.forEach((tok, i) => {
    const w = tok.norm.replace(/^'+|'+$/g, "");

    if (WEAK_WORDS.has(w)) {
      out.push({
        kind: "weak",
        tokenIndexes: [i],
        charMarks: [],
        phrase: tok.raw,
        detail: "機能語：非常に弱く、短く発音する候補",
      });
    }

    // Flap t: vowel + t/tt + vowel (water, letter, better, city…)
    const flapRe = /[aeiou](t{1,2})(?=[aeiouy])/g;
    let fm: RegExpExecArray | null;
    while ((fm = flapRe.exec(w)) !== null) {
      const from = fm.index + 1;
      out.push({
        kind: "flap",
        tokenIndexes: [i],
        charMarks: [{ token: i, from, to: from + (fm[1]?.length ?? 1) }],
        phrase: tok.raw,
        detail: "母音＋t＋母音：t がダ行・ラ行に近い音になる候補",
      });
    }

    const next = toks[i + 1];
    if (!next) return;
    const end = effectiveEnd(w);
    if (!end.letter || VOWEL_LETTERS.has(end.letter)) return;
    const nextNorm = next.norm.replace(/^'+|'+$/g, "");
    if (startsWithVowelSound(nextNorm)) {
      // 連結: consonant + vowel
      out.push({
        kind: "liaison",
        tokenIndexes: [i, i + 1],
        charMarks: [
          { token: i, from: end.index, to: end.index + 1 },
          { token: i + 1, from: 0, to: 1 },
        ],
        phrase: `${tok.raw} ${next.raw}`,
        detail: "子音＋母音：つなげて読む候補",
      });
    } else if (PLOSIVES.has(end.letter)) {
      // 消失: plosive + consonant
      out.push({
        kind: "elision",
        tokenIndexes: [i, i + 1],
        charMarks: [{ token: i, from: end.index, to: end.index + 1 }],
        phrase: `${tok.raw} ${next.raw}`,
        detail: "破裂音＋子音：前の破裂音が消える候補",
      });
    }
  });
  return out.sort(
    (a, b) =>
      (a.tokenIndexes[0] ?? 0) - (b.tokenIndexes[0] ?? 0) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}
