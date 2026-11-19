// Web Speech API typings, recognition constants, and the pure
// transcript-candidate builder.
//
// This module holds only types, constants, and pure helpers. The
// recognition session lifecycle itself (start / restart / stop /
// cancel) lives whole in hooks/useRecordingSession.ts and must not
// be split across files: its refs and handlers are tightly coupled,
// and splitting them is how "session ends are not restarted" bugs
// come back.

// --- Minimal Web Speech API typings (not in the standard DOM lib) ---
export interface SRAlternative {
  transcript: string;
  confidence?: number;
}
export interface SRResultItem {
  isFinal: boolean;
  length: number;
  [index: number]: SRAlternative;
}
export interface SRResultEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SRResultItem };
}
export interface SRErrorEvent {
  error: string;
}
export interface SRLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SRResultEvent) => void) | null;
  onerror: ((event: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?: () => void;
}

export type SRCtor = new () => SRLike;

/**
 * Build full-sentence candidate transcripts from the per-segment
 * alternatives the browser recognizer returned. Each final segment
 * contributes its alternatives (index 0 is the recognizer's best guess);
 * the candidates are the combinations across segments, capped so a long
 * utterance cannot explode combinatorially. The first candidate is
 * always the all-best-guess transcript, so when the browser returns
 * only one alternative per segment this is just `[heard]` and scoring
 * behaves exactly as before. The server scores every candidate and
 * keeps the one closest to the target sentence.
 */
export function buildCandidateTranscripts(segments: string[][]): string[] {
  const cleaned: string[][] = [];
  for (const seg of segments) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of seg) {
      const t = raw.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    if (out.length > 0) cleaned.push(out);
  }
  if (cleaned.length === 0) return [];
  const MAX_CANDIDATES = 32;
  let combos: string[] = [""];
  for (const seg of cleaned) {
    const next: string[] = [];
    for (const prefix of combos) {
      for (const alt of seg) {
        next.push(prefix ? `${prefix} ${alt}`.trim() : alt);
        if (next.length >= MAX_CANDIDATES) break;
      }
      if (next.length >= MAX_CANDIDATES) break;
    }
    combos = next;
  }
  const seenAll = new Set<string>();
  return combos.filter((c) => {
    const key = c.toLowerCase();
    if (seenAll.has(key)) return false;
    seenAll.add(key);
    return true;
  });
}

/** A promise plus its resolver: signals that recognition has fully
 *  ended after being asked to stop. */
export function createSettledSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Upper bound on mid-take recognition restarts, so a recognizer that
 *  ends immediately every time cannot spin in a restart loop. Any
 *  result resets the budget. Reaching the cap gives up on recognition
 *  for the take, but never silently: the reason is left on screen. */
export const MAX_RECOGNITION_RESTARTS = 30;

/** A recognition session that ends within this window of starting,
 *  without producing a single result, counts as a failed start rather
 *  than a healthy session that merely paused. */
export const EARLY_END_MS = 1500;

/** How many failed starts in a row are retried before the take gives
 *  up on recognition and says why, instead of silently restarting. */
export const MAX_EARLY_FAILURES = 3;

/** Hard cap on waiting for the previous take's recognition session to
 *  actually end before a new take may start. The wait normally ends
 *  with the session's own `onend`; the cap exists only so a session
 *  whose `onend` never arrives cannot wedge recording forever — and
 *  even then the new session is NOT started over the old one: the
 *  take is aborted with the reason left on screen. */
export const PREV_SESSION_WAIT_CAP_MS = 20_000;

export function getRecognitionCtor(): SRCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type Phase =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "scoring"
  | "done"
  | "recordedOnly";
