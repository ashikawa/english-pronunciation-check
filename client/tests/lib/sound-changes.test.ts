// Unit tests for the sound-change candidate detection
// (client/src/lib/sound-changes.ts).
//
// Scope: parseTokens (tokenizing the practice text) and findCandidates
// (the spelling-based 連結 / 消失 / フラップ / 弱形 heuristics from the
// teacher's four basic patterns). Both are pure functions with no
// browser dependencies, so the boundary cases that are impractical to
// cover by hand on a real device — silent h, silent trailing "e",
// /w/ and /j/ onsets, flap position marks, result ordering — are
// pinned down here. The candidates are estimates from spelling; these
// tests pin the CURRENT heuristic behavior, including its known
// simplifications, so a future change to the rules is a deliberate
// test change, not a silent drift.
//
// Tests live under client/tests/ (mirroring client/src/), following
// the server/tests/ precedent, so production source stays test-free.
// Run with: bun run test  (bun test server/tests client/tests)

import { describe, expect, test } from "bun:test";
import {
  findCandidates,
  parseTokens,
  type Candidate,
} from "../../src/lib/sound-changes";

function candidatesOf(text: string): Candidate[] {
  return findCandidates(parseTokens(text));
}

function kindsOf(text: string): string[] {
  return candidatesOf(text).map((c) => c.kind);
}

describe("parseTokens", () => {
  test("splits on punctuation and spaces, keeping offsets", () => {
    expect(parseTokens("Hello, world!")).toEqual([
      { raw: "Hello", norm: "hello", start: 0, end: 5 },
      { raw: "world", norm: "world", start: 7, end: 12 },
    ]);
  });

  test("norm lowercases and normalizes curly apostrophes", () => {
    expect(parseTokens("Don’t STOP")).toEqual([
      { raw: "Don’t", norm: "don't", start: 0, end: 5 },
      { raw: "STOP", norm: "stop", start: 6, end: 10 },
    ]);
  });

  test("keeps digits as tokens", () => {
    expect(parseTokens("Room 101")).toEqual([
      { raw: "Room", norm: "room", start: 0, end: 4 },
      { raw: "101", norm: "101", start: 5, end: 8 },
    ]);
  });

  test("empty or punctuation-only input yields no tokens", () => {
    expect(parseTokens("")).toEqual([]);
    expect(parseTokens("   ")).toEqual([]);
    expect(parseTokens("?!...")).toEqual([]);
  });
});

describe("findCandidates — 弱形 (weak forms)", () => {
  test("function words are weak candidates, matched case-insensitively", () => {
    expect(candidatesOf("the cat")).toEqual([
      {
        kind: "weak",
        tokenIndexes: [0],
        charMarks: [],
        phrase: "the",
        detail: "機能語：非常に弱く、短く発音する候補",
      },
    ]);
    // The phrase keeps the original casing from the text.
    expect(candidatesOf("The end").filter((c) => c.kind === "weak")).toEqual([
      {
        kind: "weak",
        tokenIndexes: [0],
        charMarks: [],
        phrase: "The",
        detail: "機能語：非常に弱く、短く発音する候補",
      },
    ]);
  });

  test("only listed function words qualify — content words and 'I' do not", () => {
    // "am" is in the weak list; "I" and "here" are not.
    expect(candidatesOf("I am here")).toEqual([
      {
        kind: "weak",
        tokenIndexes: [1],
        charMarks: [],
        phrase: "am",
        detail: "機能語：非常に弱く、短く発音する候補",
      },
    ]);
    expect(kindsOf("cats dogs")).toEqual([]);
  });
});

describe("findCandidates — フラップ (flap t)", () => {
  test("vowel + t + vowel marks the t", () => {
    expect(candidatesOf("water")).toEqual([
      {
        kind: "flap",
        tokenIndexes: [0],
        charMarks: [{ token: 0, from: 2, to: 3 }],
        phrase: "water",
        detail: "母音＋t＋母音：t がダ行・ラ行に近い音になる候補",
      },
    ]);
  });

  test("double t is marked as one span, and y after t also counts", () => {
    expect(candidatesOf("letter")[0]?.charMarks).toEqual([
      { token: 0, from: 2, to: 4 },
    ]);
    expect(candidatesOf("city")[0]?.charMarks).toEqual([
      { token: 0, from: 2, to: 3 },
    ]);
  });

  test("a word-final t is not a flap", () => {
    expect(kindsOf("cat")).toEqual([]);
    expect(kindsOf("hot")).toEqual([]);
  });
});

describe("findCandidates — 連結 (liaison)", () => {
  test("consonant-final word + vowel-initial word links, marking both sides", () => {
    expect(candidatesOf("pick it")).toEqual([
      {
        kind: "liaison",
        tokenIndexes: [0, 1],
        charMarks: [
          { token: 0, from: 3, to: 4 },
          { token: 1, from: 0, to: 1 },
        ],
        phrase: "pick it",
        detail: "子音＋母音：つなげて読む候補",
      },
    ]);
  });

  test("a silent trailing 'e' is skipped for the final consonant (take → k)", () => {
    const [c] = candidatesOf("take it");
    expect(c?.kind).toBe("liaison");
    // The mark is on the k (index 2), not on the silent e.
    expect(c?.charMarks).toEqual([
      { token: 0, from: 2, to: 3 },
      { token: 1, from: 0, to: 1 },
    ]);
  });

  test("silent h words count as vowel-initial (hour, honest, …)", () => {
    const kinds = kindsOf("an hour");
    expect(kinds).toContain("liaison");
    const liaison = candidatesOf("an hour").find((c) => c.kind === "liaison");
    expect(liaison?.phrase).toBe("an hour");
  });

  test("chained links are each reported (pick it up)", () => {
    const phrases = candidatesOf("pick it up").map((c) => c.phrase);
    expect(phrases).toEqual(["pick it", "it up"]);
  });

  test("a vowel-final word never starts a liaison", () => {
    expect(candidatesOf("go home")).toEqual([]);
  });
});

describe("findCandidates — 消失 (elision)", () => {
  test("plosive-final word + consonant-initial word drops the plosive", () => {
    expect(candidatesOf("good boy")).toEqual([
      {
        kind: "elision",
        tokenIndexes: [0, 1],
        charMarks: [{ token: 0, from: 3, to: 4 }],
        phrase: "good boy",
        detail: "破裂音＋子音：前の破裂音が消える候補",
      },
    ]);
    expect(candidatesOf("last night")[0]?.kind).toBe("elision");
  });

  test("the silent-'e' skip applies to elision too (take care → k drops)", () => {
    const [c] = candidatesOf("take care");
    expect(c?.kind).toBe("elision");
    expect(c?.charMarks).toEqual([{ token: 0, from: 2, to: 3 }]);
  });

  test("a non-plosive final consonant + consonant yields no candidate", () => {
    // "feel" ends in l (not a plosive) and "good" starts with a consonant.
    expect(candidatesOf("feel good")).toEqual([]);
  });

  test("/w/-onset words (one, once) are not vowel-initial, so a plosive before them elides instead of linking", () => {
    // Documents the current heuristic: "one" is treated as starting
    // with a consonant sound, so "take one" is an elision candidate,
    // not a liaison candidate.
    const cands = candidatesOf("take one");
    expect(cands.map((c) => c.kind)).toEqual(["elision"]);
    expect(cands[0]?.phrase).toBe("take one");
  });

  test("a contraction-final plosive can elide (don't stop)", () => {
    const [c] = candidatesOf("don’t stop");
    expect(c?.kind).toBe("elision");
    expect(c?.charMarks).toEqual([{ token: 0, from: 4, to: 5 }]);
  });
});

describe("findCandidates — ordering", () => {
  test("results sort by first token, then liaison < elision < flap < weak", () => {
    // "water" alone yields flap; before "is" it also yields liaison,
    // and "is" itself is weak. Liaison must come before flap for the
    // same starting token.
    expect(kindsOf("water is")).toEqual(["liaison", "flap", "weak"]);
    expect(kindsOf("The end")).toEqual(["liaison", "weak"]);
  });

  test("plain sentences without any pattern yield no candidates", () => {
    expect(candidatesOf("Hello, world!")).toEqual([]);
    expect(candidatesOf("")).toEqual([]);
  });
});
