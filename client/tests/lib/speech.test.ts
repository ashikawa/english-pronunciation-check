// Unit tests for the pure helpers in client/src/lib/speech.ts.
//
// Scope: buildCandidateTranscripts (combining the recognizer's
// per-segment alternatives into full-sentence candidates for scoring)
// and createSettledSignal (the promise that signals a recognition
// session has fully ended). Both are pure — no browser access.
// getRecognitionCtor is deliberately NOT covered: it only reads the
// browser's window object, and the recognition session lifecycle
// itself lives in hooks/useRecordingSession.ts, tightly coupled to
// React and the live recognizer, so it stays verified on-device.
//
// Tests live under client/tests/ (mirroring client/src/), following
// the server/tests/ precedent. Run with: bun run test
// (bun test server/tests client/tests)

import { describe, expect, test } from "bun:test";
import {
  buildCandidateTranscripts,
  createSettledSignal,
  EARLY_END_MS,
  MAX_EARLY_FAILURES,
  MAX_RECOGNITION_RESTARTS,
  PREV_SESSION_WAIT_CAP_MS,
} from "../../src/lib/speech";

describe("buildCandidateTranscripts", () => {
  test("a single alternative per segment yields just the best-guess transcript", () => {
    expect(buildCandidateTranscripts([["hello world"]])).toEqual([
      "hello world",
    ]);
    expect(
      buildCandidateTranscripts([["I will"], ["call you"]]),
    ).toEqual(["I will call you"]);
  });

  test("the first candidate is always the all-best-guess combination", () => {
    expect(buildCandidateTranscripts([["I", "eye"], ["scream"]])).toEqual([
      "I scream",
      "eye scream",
    ]);
  });

  test("alternatives are trimmed and blanks are skipped", () => {
    expect(buildCandidateTranscripts([["  hello  ", "   "]])).toEqual([
      "hello",
    ]);
  });

  test("alternatives are de-duplicated case-insensitively within a segment, keeping the first form", () => {
    expect(buildCandidateTranscripts([["Hello", "hello", "HELLO"]])).toEqual([
      "Hello",
    ]);
  });

  test("combinations are de-duplicated case-insensitively as well", () => {
    expect(buildCandidateTranscripts([["a", "A"], ["b"]])).toEqual(["a b"]);
  });

  test("empty segments are dropped; no usable input yields no candidates", () => {
    expect(buildCandidateTranscripts([["hello"], [], ["world"]])).toEqual([
      "hello world",
    ]);
    expect(buildCandidateTranscripts([])).toEqual([]);
    expect(buildCandidateTranscripts([[]])).toEqual([]);
    expect(buildCandidateTranscripts([["  "]])).toEqual([]);
  });

  test("combinations are capped at 32 so long utterances cannot explode", () => {
    // 6 segments × 2 alternatives = 64 combinations without the cap.
    const segments = Array.from({ length: 6 }, (_, i) => [
      `w${i}a`,
      `w${i}b`,
    ]);
    const out = buildCandidateTranscripts(segments);
    expect(out.length).toBe(32);
    expect(out[0]).toBe("w0a w1a w2a w3a w4a w5a");
  });
});

describe("createSettledSignal", () => {
  test("the promise stays pending until resolve is called", async () => {
    const signal = createSettledSignal();
    let settled = false;
    void signal.promise.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    signal.resolve();
    await signal.promise;
    expect(settled).toBe(true);
  });

  test("resolving twice is harmless, and signals are independent", async () => {
    const a = createSettledSignal();
    const b = createSettledSignal();
    let bSettled = false;
    void b.promise.then(() => {
      bSettled = true;
    });
    a.resolve();
    a.resolve();
    await a.promise;
    await new Promise((r) => setTimeout(r, 10));
    expect(bSettled).toBe(false);
    b.resolve();
    await b.promise;
    expect(bSettled).toBe(true);
  });
});

describe("recognition constants", () => {
  test("the restart / failed-start budgets the session hook relies on", () => {
    // These values are behavior, not trivia: they bound the mid-take
    // restart loop and the previous-session wait in
    // hooks/useRecordingSession.ts. Changing one should be a
    // deliberate test change.
    expect(MAX_RECOGNITION_RESTARTS).toBe(30);
    expect(EARLY_END_MS).toBe(1500);
    expect(MAX_EARLY_FAILURES).toBe(3);
    expect(PREV_SESSION_WAIT_CAP_MS).toBe(20_000);
  });
});
