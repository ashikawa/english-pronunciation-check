// Unit tests for the pure scoring core (server/src/actions/scoring-core.ts).
//
// Scope, per the user's request: the scoring logic only — tokenize,
// diffWords (LCS alignment + score), and selectBestCandidate (the
// alternative-transcript selection). The recordAttempt action wrapper
// (feedback generation, DB insert) and the Notion/history features are
// deliberately NOT covered here: they need the runtime ctx / external
// services, so unit tests for them would only exercise mocks.
//
// Tests live under server/tests/ (mirroring server/src/) so production
// source stays test-free. Run with: bun run test  (bun test server/tests)

import { describe, expect, test } from "bun:test";
import {
  diffWords,
  selectBestCandidate,
  tokenize,
} from "../../src/actions/scoring-core";

describe("tokenize", () => {
  test("lowercases and strips punctuation", () => {
    expect(tokenize("The weather is nice today.")).toEqual([
      "the",
      "weather",
      "is",
      "nice",
      "today",
    ]);
    expect(tokenize("  Hello,   WORLD!  ")).toEqual(["hello", "world"]);
  });

  test("normalizes curly apostrophes and keeps contractions together", () => {
    expect(tokenize("Don’t stop, it’s fine")).toEqual([
      "don't",
      "stop",
      "it's",
      "fine",
    ]);
    expect(tokenize("don't")).toEqual(["don't"]);
  });

  test("splits hyphenated words and keeps digits", () => {
    expect(tokenize("well-known fact")).toEqual(["well", "known", "fact"]);
    expect(tokenize("It's 2026 now")).toEqual(["it's", "2026", "now"]);
  });

  test("empty or punctuation-only input yields no tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("?!...")).toEqual([]);
  });
});

describe("diffWords", () => {
  test("perfect match scores 100 with every word ok", () => {
    const { words, score } = diffWords(
      "The weather is nice today",
      "The weather is nice today",
    );
    expect(score).toBe(100);
    expect(words).toEqual([
      { word: "the", status: "ok", heard: "the" },
      { word: "weather", status: "ok", heard: "weather" },
      { word: "is", status: "ok", heard: "is" },
      { word: "nice", status: "ok", heard: "nice" },
      { word: "today", status: "ok", heard: "today" },
    ]);
  });

  test("matching is case- and punctuation-insensitive", () => {
    const { words, score } = diffWords("Hello, world!", "hello world");
    expect(score).toBe(100);
    expect(words.every((w) => w.status === "ok")).toBe(true);
  });

  test("a substituted word is wrong and carries what was heard", () => {
    const { words, score } = diffWords("the cat sat", "the dog sat");
    expect(words).toEqual([
      { word: "the", status: "ok", heard: "the" },
      { word: "cat", status: "wrong", heard: "dog" },
      { word: "sat", status: "ok", heard: "sat" },
    ]);
    expect(score).toBe(67); // 2/3, rounded
  });

  test("an omitted word is missing and the rest still aligns", () => {
    const { words, score } = diffWords("i want to go home", "i want go home");
    expect(words).toEqual([
      { word: "i", status: "ok", heard: "i" },
      { word: "want", status: "ok", heard: "want" },
      { word: "to", status: "missing", heard: null },
      { word: "go", status: "ok", heard: "go" },
      { word: "home", status: "ok", heard: "home" },
    ]);
    expect(score).toBe(80);
  });

  test("empty transcript marks every word missing and scores 0", () => {
    const { words, score } = diffWords("hello world", "");
    expect(words).toEqual([
      { word: "hello", status: "missing", heard: null },
      { word: "world", status: "missing", heard: null },
    ]);
    expect(score).toBe(0);
  });

  test("empty target yields no words and score 0", () => {
    expect(diffWords("", "hello")).toEqual({ words: [], score: 0 });
    expect(diffWords("   ", "hello")).toEqual({ words: [], score: 0 });
  });

  test("extra heard words do not lower the score", () => {
    // Trailing additions: every target word was still said.
    expect(diffWords("thank you", "thank you very much").score).toBe(100);
    // Inserted word in the middle: LCS still aligns all target words.
    const { words, score } = diffWords("i like cats", "i really like cats");
    expect(score).toBe(100);
    expect(words.every((w) => w.status === "ok")).toBe(true);
  });

  test("leftover heard words pair with unmatched target words in order", () => {
    const { words, score } = diffWords(
      "she sells seashells",
      "she sells sea shells by the shore",
    );
    expect(words).toEqual([
      { word: "she", status: "ok", heard: "she" },
      { word: "sells", status: "ok", heard: "sells" },
      { word: "seashells", status: "wrong", heard: "sea" },
    ]);
    expect(score).toBe(67);
  });

  test("score is the rounded percentage of ok words", () => {
    expect(diffWords("a b c", "a x y").score).toBe(33); // 1/3
    expect(diffWords("a b c d e f", "a b x x x x").score).toBe(33); // 2/6
    expect(diffWords("a b c d e f", "a b c d x x").score).toBe(67); // 4/6
  });

  test("duplicate target words match one occurrence each", () => {
    const { words, score } = diffWords("the the", "the");
    expect(words).toEqual([
      { word: "the", status: "ok", heard: "the" },
      { word: "the", status: "missing", heard: null },
    ]);
    expect(score).toBe(50);
  });

  test("swapped word order: only the LCS word counts as ok", () => {
    // Documents current alignment behavior: with "cats and dogs" heard
    // as "dogs and cats", the LCS walk keeps one word matched and the
    // other two pair up as wrong in order.
    const { words, score } = diffWords("cats and dogs", "dogs and cats");
    expect(words).toEqual([
      { word: "cats", status: "wrong", heard: "and" },
      { word: "and", status: "wrong", heard: "cats" },
      { word: "dogs", status: "ok", heard: "dogs" },
    ]);
    expect(score).toBe(33);
  });
});

describe("selectBestCandidate", () => {
  test("without candidates it scores the primary transcript as-is", () => {
    const r = selectBestCandidate("hello world", "hello world");
    expect(r.heard).toBe("hello world");
    expect(r.score).toBe(100);
  });

  test("a better alternative wins and becomes the scored transcript", () => {
    const r = selectBestCandidate(
      "i scream for ice cream",
      "i scream for i scream",
      ["i scream for ice cream"],
    );
    expect(r.heard).toBe("i scream for ice cream");
    expect(r.score).toBe(100);
    expect(r.words.every((w) => w.status === "ok")).toBe(true);
  });

  test("a tie keeps the primary transcript (recognizer's best guess)", () => {
    const r = selectBestCandidate("hello world", "hello there", [
      "hello friend",
    ]);
    expect(r.score).toBe(50);
    expect(r.heard).toBe("hello there");
  });

  test("a worse alternative never replaces the primary", () => {
    const r = selectBestCandidate("hello world", "hello world", [
      "totally different words",
    ]);
    expect(r.heard).toBe("hello world");
    expect(r.score).toBe(100);
  });

  test("candidates are de-duplicated case-insensitively; primary kept verbatim", () => {
    const r = selectBestCandidate("hello world", "Hello World", [
      "hello world",
      "HELLO WORLD",
    ]);
    expect(r.heard).toBe("Hello World");
    expect(r.score).toBe(100);
  });

  test("candidates are trimmed, and blank ones are skipped", () => {
    const r = selectBestCandidate("hello world", "", [
      "   ",
      "  hello world  ",
    ]);
    expect(r.heard).toBe("hello world");
    expect(r.score).toBe(100);
  });

  test("empty primary with no usable candidates scores 0, all missing", () => {
    const r = selectBestCandidate("hello world", "");
    expect(r.heard).toBe("");
    expect(r.score).toBe(0);
    expect(r.words).toEqual([
      { word: "hello", status: "missing", heard: null },
      { word: "world", status: "missing", heard: null },
    ]);
  });

  test("at most 32 transcripts are considered, primary first", () => {
    // 40 distinct losing fillers, then the perfect transcript at the
    // very end — past the cap, so it must NOT be picked.
    const fillers = Array.from({ length: 40 }, (_, i) => `filler number ${i}`);
    const r = selectBestCandidate("the perfect sentence", "wrong", [
      ...fillers,
      "the perfect sentence",
    ]);
    expect(r.heard).not.toBe("the perfect sentence");
    expect(r.score).toBeLessThan(100);
  });

  test("undefined and empty candidate lists behave like no candidates", () => {
    expect(selectBestCandidate("hello world", "hello world", undefined).score).toBe(100);
    expect(selectBestCandidate("hello world", "hello world", []).score).toBe(100);
  });
});
