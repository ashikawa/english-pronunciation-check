import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

const FIELDS = actionFields<typeof Actions>();

type Attempt = ApiResponse<typeof api, "recordAttempt">;

// --- Notion save destinations (kept in this device's localStorage) ---
// The destination list is a per-device picker convenience, so it lives
// in the browser, not the server database. Searching still goes through
// the server (it needs the Notion connection); the results are merged
// into the local list here.

type Destination = {
  pageId: string;
  title: string;
  url: string;
  path: string | null;
  isDefault: boolean;
};

const DEST_STORAGE_KEY = "notion-destinations-v1";

function loadStoredDestinations(): Destination[] {
  try {
    const raw = window.localStorage.getItem(DEST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Destination[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.pageId === "string" &&
        rec.pageId !== "" &&
        typeof rec.title === "string" &&
        typeof rec.url === "string"
      ) {
        out.push({
          pageId: rec.pageId,
          title: rec.title,
          url: rec.url,
          path: typeof rec.path === "string" ? rec.path : null,
          isDefault: rec.isDefault === true,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function storeDestinations(destinations: Destination[]) {
  try {
    window.localStorage.setItem(DEST_STORAGE_KEY, JSON.stringify(destinations));
  } catch {
    // Storage full or unavailable: the picker still works for this session.
  }
}

// --- Practice text (kept in this device's localStorage) ---
// The text being practiced is a per-device draft, so it lives in the
// browser, not the server database. The current input is auto-saved
// and restored on the next visit; the user can also save texts to a
// list and call them back later. Both are cleared from the UI.

const PRACTICE_TEXT_KEY = "practice-text-v1";
const SAVED_TEXTS_KEY = "saved-practice-texts-v1";
const SAVED_TEXTS_LIMIT = 50;

function loadStoredPracticeText(): string {
  try {
    return window.localStorage.getItem(PRACTICE_TEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

function storePracticeText(text: string) {
  try {
    if (text) {
      window.localStorage.setItem(PRACTICE_TEXT_KEY, text);
    } else {
      window.localStorage.removeItem(PRACTICE_TEXT_KEY);
    }
  } catch {
    // Storage unavailable: the text still works for this session.
  }
}

function loadStoredSavedTexts(): string[] {
  try {
    const raw = window.localStorage.getItem(SAVED_TEXTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const t = item.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= SAVED_TEXTS_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

function storeSavedTexts(texts: string[]) {
  try {
    if (texts.length > 0) {
      window.localStorage.setItem(SAVED_TEXTS_KEY, JSON.stringify(texts));
    } else {
      window.localStorage.removeItem(SAVED_TEXTS_KEY);
    }
  } catch {
    // Storage unavailable: the list still works for this session.
  }
}

// --- Minimal Web Speech API typings (not in the standard DOM lib) ---
interface SRAlternative {
  transcript: string;
  confidence?: number;
}
interface SRResultItem {
  isFinal: boolean;
  length: number;
  [index: number]: SRAlternative;
}
interface SRResultEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SRResultItem };
}
interface SRErrorEvent {
  error: string;
}
interface SRLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SRResultEvent) => void) | null;
  onerror: ((event: SRErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort?: () => void;
}

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
function buildCandidateTranscripts(segments: string[][]): string[] {
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
type SRCtor = new () => SRLike;

function getRecognitionCtor(): SRCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Phase = "idle" | "recording" | "scoring" | "done" | "recordedOnly";

const SERIF = "Georgia, 'Times New Roman', 'Hiragino Mincho ProN', serif";

// --- Sound-change candidates (連結 / 消失 / フラップ / 弱形) ---
// Heuristic detection from spelling only, following the teacher's four
// basic patterns. These are candidates to check while shadowing, NOT a
// phoneme-level judgement: whether the sound actually changed cannot be
// verified from the word-level transcript.

type ChangeKind = "liaison" | "elision" | "flap" | "weak";

const KIND_META: Record<ChangeKind, { label: string; color: string; bg: string }> = {
  liaison: { label: "連結", color: "var(--cand-liaison)", bg: "var(--cand-liaison-bg)" },
  elision: { label: "消失", color: "var(--cand-elision)", bg: "var(--cand-elision-bg)" },
  flap: { label: "フラップ", color: "var(--cand-flap)", bg: "var(--cand-flap-bg)" },
  weak: { label: "弱形", color: "var(--cand-weak)", bg: "transparent" },
};
const KIND_ORDER: ChangeKind[] = ["liaison", "elision", "flap", "weak"];

interface Tok {
  raw: string;
  norm: string;
  start: number;
  end: number;
}

interface Candidate {
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

function parseTokens(text: string): Tok[] {
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

function findCandidates(toks: Tok[]): Candidate[] {
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

/** Encode a Blob as base64 in chunks (safe for multi-MB recordings). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function App() {
  const queryClient = useQueryClient();
  const [customText, setCustomText] = useState<string>(loadStoredPracticeText);
  const [savedTexts, setSavedTexts] = useState<string[]>(loadStoredSavedTexts);
  const [confirmClearSaved, setConfirmClearSaved] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<Attempt | null>(null);
  const [liveHeard, setLiveHeard] = useState("");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [recognitionSupported] = useState(() => getRecognitionCtor() !== null);
  // Notion export (opt-in, per result)
  const [wantNotion, setWantNotion] = useState(false);
  const [destinations, setDestinations] = useState<Destination[]>(loadStoredDestinations);
  const [selectedDest, setSelectedDest] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [destQueryError, setDestQueryError] = useState<string | null>(null);
  const [notionMsg, setNotionMsg] = useState<string | null>(null);
  const [historyNotionMsg, setHistoryNotionMsg] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingBlobRef = useRef<Blob | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SRLike | null>(null);
  // Set when the user cancels mid-recording or mid-scoring: the recorder's
  // onstop handler and the scoring mutation check it and discard the take
  // instead of scoring / keeping it.
  const cancelledRef = useRef(false);
  const finalHeardRef = useRef("");
  // Alternatives per final recognition segment, in arrival order:
  // finalSegmentsRef.current[i] is the list of transcripts the browser
  // offered for segment i (index 0 = its best guess).
  const finalSegmentsRef = useRef<string[][]>([]);
  const timerRef = useRef<number | null>(null);

  const target = customText.trim();

  const tokens = useMemo(() => parseTokens(customText), [customText]);
  const candidates = useMemo(() => findCandidates(tokens), [tokens]);
  const candidateCounts = useMemo(() => {
    const map = new Map<ChangeKind, number>();
    for (const c of candidates) map.set(c.kind, (map.get(c.kind) ?? 0) + 1);
    return map;
  }, [candidates]);
  const charMarks = useMemo(() => {
    const map = new Map<number, Map<number, ChangeKind>>();
    for (const c of candidates) {
      for (const mark of c.charMarks) {
        let inner = map.get(mark.token);
        if (!inner) {
          inner = new Map();
          map.set(mark.token, inner);
        }
        for (let k = mark.from; k < mark.to; k++) inner.set(k, c.kind);
      }
    }
    return map;
  }, [candidates]);
  const liaisonBefore = useMemo(
    () =>
      new Set(
        candidates
          .filter((c) => c.kind === "liaison")
          .map((c) => c.tokenIndexes[1])
          .filter((v): v is number => v !== undefined),
      ),
    [candidates],
  );
  const weakTokens = useMemo(
    () =>
      new Set(
        candidates
          .filter((c) => c.kind === "weak")
          .map((c) => c.tokenIndexes[0])
          .filter((v): v is number => v !== undefined),
      ),
    [candidates],
  );

  // After scoring, a candidate counts as "通じた可能性あり" when every word
  // it spans was recognized. Only valid while the result's word list still
  // aligns with the current text's tokens.
  function candidateStatus(c: Candidate): "passed" | "check" | null {
    if (!result || result.words.length !== tokens.length) return null;
    return c.tokenIndexes.every((idx) => result.words[idx]?.status === "ok")
      ? "passed"
      : "check";
  }

  function renderAnnotated(): ReactNode {
    const nodes: ReactNode[] = [];
    let cursor = 0;
    tokens.forEach((tok, i) => {
      if (tok.start > cursor) {
        const gap = customText.slice(cursor, tok.start);
        if (liaisonBefore.has(i) && /^\s+$/.test(gap)) {
          nodes.push(
            <span key={`gap-${i}`} style={{ color: "var(--cand-liaison)", fontWeight: 700 }}>
              ‿
            </span>,
          );
        } else {
          nodes.push(<span key={`gap-${i}`}>{gap}</span>);
        }
      }
      const marks = charMarks.get(i);
      nodes.push(
        <span
          key={`tok-${i}`}
          style={
            weakTokens.has(i)
              ? {
                  textDecoration: "underline dotted var(--cand-weak) 2px",
                  textUnderlineOffset: "4px",
                }
              : undefined
          }
        >
          {tok.raw.split("").map((ch, ci) => {
            const kind = marks?.get(ci);
            if (!kind) return <span key={ci}>{ch}</span>;
            const meta = KIND_META[kind];
            return (
              <span
                key={ci}
                style={{
                  color: meta.color,
                  backgroundColor: meta.bg,
                  borderRadius: 4,
                  fontWeight: 700,
                  padding: "0 1px",
                  textDecoration: kind === "elision" ? "line-through" : undefined,
                }}
              >
                {ch}
              </span>
            );
          })}
        </span>,
      );
      cursor = tok.end;
    });
    if (cursor < customText.length) {
      nodes.push(<span key="tail">{customText.slice(cursor)}</span>);
    }
    return nodes;
  }

  const attemptsQuery = useQuery({
    queryKey: ["attempts"],
    queryFn: () => api.listAttempts({ limit: 50 }),
  });
  const attempts = attemptsQuery.data?.attempts ?? [];

  const bestByTarget = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of attempts) {
      const prev = map.get(a.target);
      if (prev === undefined || a.score > prev) map.set(a.target, a.score);
    }
    return map;
  }, [attempts]);

  const currentBest = target ? bestByTarget.get(target) : undefined;

  const recordMutation = useMutation({
    mutationFn: (v: { target: string; heard: string; heardCandidates?: string[] }) =>
      api.recordAttempt(v),
    onSuccess: (data) => {
      if (cancelledRef.current) {
        // Cancelled while scoring: drop the just-saved attempt so the
        // cancelled take leaves no result and no history entry.
        cancelledRef.current = false;
        void api
          .deleteAttempt({ id: data.id })
          .catch(() => undefined)
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: ["attempts"] });
          });
        resetAttemptState();
        setInfoMsg("キャンセルしました。録音と採点は中止されました。");
        return;
      }
      setResult(data);
      setPhase("done");
      void queryClient.invalidateQueries({ queryKey: ["attempts"] });
    },
    onError: () => {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        resetAttemptState();
        setInfoMsg("キャンセルしました。録音と採点は中止されました。");
        return;
      }
      setError("採点に失敗しました。通信状態を確認してもう一度お試しください。");
      setPhase("idle");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteAttempt({ id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["attempts"] }),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearAttempts({}),
    onSuccess: () => {
      setConfirmClear(false);
      void queryClient.invalidateQueries({ queryKey: ["attempts"] });
    },
  });

  // --- Practice text persistence (localStorage) ---
  // Auto-save the current input so it is restored on the next visit,
  // and persist the saved-texts list the same way.
  useEffect(() => {
    storePracticeText(customText);
  }, [customText]);

  useEffect(() => {
    storeSavedTexts(savedTexts);
  }, [savedTexts]);

  const isCurrentTextSaved = target !== "" && savedTexts.includes(target);

  function clearPracticeText() {
    if (busy) return;
    setCustomText("");
    resetAttemptState();
    setInfoMsg("テキストをクリアしました。");
  }

  function saveCurrentText() {
    const t = customText.trim();
    if (!t) {
      setError("保存する英文を入力してください。");
      return;
    }
    setError(null);
    if (savedTexts.includes(t)) {
      setInfoMsg("この英文はすでに保存されています。");
      return;
    }
    setSavedTexts((prev) => [t, ...prev].slice(0, SAVED_TEXTS_LIMIT));
    setInfoMsg("英文を保存しました。下の「保存済みの英文」から次回も呼び出せます。");
  }

  function loadSavedText(text: string) {
    if (busy) return;
    setCustomText(text);
    resetAttemptState();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteSavedText(text: string) {
    setSavedTexts((prev) => prev.filter((t) => t !== text));
  }

  function clearAllSavedTexts() {
    setSavedTexts([]);
    setConfirmClearSaved(false);
    setInfoMsg("保存済みの英文をすべて削除しました。");
  }

  // --- Notion export ---
  // The destination list lives in localStorage (see loadStoredDestinations);
  // every change is written back so the picker survives reloads on this
  // device. Searching proxies through the server but stores nothing there.
  useEffect(() => {
    storeDestinations(destinations);
  }, [destinations]);

  const defaultDest = destinations.find((d) => d.isDefault) ?? destinations[0];
  const effectiveDestId = selectedDest || defaultDest?.pageId || "__draft__";

  const searchDestMutation = useMutation({
    mutationFn: async (q: string) => await api.searchNotionPages({ query: q }),
    onSuccess: (data) => {
      if (data.pages.length === 0) {
        setNotionMsg("保存先の候補が見つかりませんでした。別の言葉で検索してください。");
        return;
      }
      setDestinations((prev) => {
        const byId = new Map(prev.map((d) => [d.pageId, d]));
        let hasDefault = prev.some((d) => d.isDefault);
        for (const p of data.pages) {
          const existing = byId.get(p.pageId);
          if (existing) {
            byId.set(p.pageId, { ...existing, title: p.title, url: p.url, path: p.path });
          } else {
            // The first page added while no default exists becomes the
            // default, until the user picks another one.
            const makeDefault = !hasDefault;
            if (makeDefault) hasDefault = true;
            byId.set(p.pageId, { ...p, isDefault: makeDefault });
          }
        }
        return [...byId.values()];
      });
    },
    onError: () => {
      setNotionMsg("保存先を検索できませんでした。Notionの接続状態を確認してください。");
    },
  });

  function setDefaultDestination(pageId: string) {
    setDestinations((prev) => prev.map((d) => ({ ...d, isDefault: d.pageId === pageId })));
  }

  type NotionSaveVars = {
    attemptId: number;
    parentPageId: string | null;
    parentTitle: string | null;
    audioBase64: string | null;
    audioMimeType: string | null;
    candidates: {
      kindLabel: string;
      phrase: string;
      detail: string;
      status: "passed" | "check" | null;
    }[];
  };

  const saveNotionMutation = useMutation({
    mutationFn: async (v: NotionSaveVars) => await api.saveToNotion(v),
    onSuccess: (data, vars) => {
      const isCurrent = result !== null && vars.attemptId === result.id;
      if (data.status === "error") {
        if (isCurrent) setNotionMsg(data.message ?? "Notionへの保存に失敗しました。");
        else setHistoryNotionMsg(data.message ?? "Notionへの保存に失敗しました。");
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["attempts"] });
      if (isCurrent && data.pageUrl) {
        setResult({
          ...result,
          notion_page_url: data.pageUrl,
          notion_parent_title: vars.parentTitle,
        });
      }
      if (!isCurrent) {
        setHistoryNotionMsg("Notionに保存しました（音声なし）。");
      }
    },
    onError: (_e, vars) => {
      const isCurrent = result !== null && vars.attemptId === result.id;
      if (isCurrent) setNotionMsg("Notionへの保存に失敗しました。通信状態を確認してください。");
      else setHistoryNotionMsg("Notionへの保存に失敗しました。通信状態を確認してください。");
    },
  });

  async function saveResultToNotion() {
    if (!result) return;
    setNotionMsg(null);
    const dest = destinations.find((d) => d.pageId === effectiveDestId);
    let audioBase64: string | null = null;
    let audioMimeType: string | null = null;
    const blob = recordingBlobRef.current;
    if (blob) {
      if (blob.size > 15 * 1024 * 1024) {
        setNotionMsg("録音が大きすぎてNotionに保存できません（目安として15MBまで）。");
        return;
      }
      audioBase64 = await blobToBase64(blob);
      audioMimeType = blob.type || "audio/webm";
    }
    saveNotionMutation.mutate({
      attemptId: result.id,
      parentPageId: dest ? dest.pageId : null,
      parentTitle: dest ? dest.title : null,
      audioBase64,
      audioMimeType,
      candidates: candidates.map((c) => ({
        kindLabel: KIND_META[c.kind].label,
        phrase: c.phrase,
        detail: c.detail,
        status: candidateStatus(c),
      })),
    });
  }

  function saveHistoryToNotion(a: Attempt) {
    setHistoryNotionMsg(null);
    const toks = parseTokens(a.target);
    const cands = findCandidates(toks);
    const payload = cands.map((c) => {
      let status: "passed" | "check" | null = null;
      if (a.words.length === toks.length) {
        status = c.tokenIndexes.every((idx) => a.words[idx]?.status === "ok")
          ? "passed"
          : "check";
      }
      return {
        kindLabel: KIND_META[c.kind].label,
        phrase: c.phrase,
        detail: c.detail,
        status,
      };
    });
    const dest = destinations.find((d) => d.isDefault) ?? destinations[0];
    saveNotionMutation.mutate({
      attemptId: a.id,
      parentPageId: dest ? dest.pageId : null,
      parentTitle: dest ? dest.title : null,
      audioBase64: null,
      audioMimeType: null,
      candidates: payload,
    });
  }

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  function resetAttemptState() {
    setResult(null);
    setLiveHeard("");
    setError(null);
    setInfoMsg(null);
    setPhase("idle");
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    recordingBlobRef.current = null;
    setWantNotion(false);
    setSelectedDest("");
    setDestQuery("");
    setDestQueryError(null);
    setNotionMsg(null);
  }

  function playModel() {
    if (!target) {
      setError("先に英文を入力してください。");
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(target);
    utter.lang = "en-US";
    utter.rate = 0.95;
    window.speechSynthesis.speak(utter);
  }

  async function startRecording() {
    setError(null);
    setInfoMsg(null);
    cancelledRef.current = false;
    setResult(null);
    if (!target) {
      setError("先に英文を入力してください。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("このブラウザでは録音が使えません。");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("マイクの使用が許可されませんでした。ブラウザの設定でマイクを許可してください。");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    finalHeardRef.current = "";
    finalSegmentsRef.current = [];
    setLiveHeard("");
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    recordingBlobRef.current = null;

    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = handleRecorderStop;
    recorderRef.current = recorder;
    recorder.start();

    const Ctor = getRecognitionCtor();
    if (Ctor) {
      try {
        const rec = new Ctor();
        rec.lang = "en-US";
        rec.interimResults = true;
        rec.continuous = true;
        // Ask the browser for several alternative transcripts per
        // segment, not just its single best guess. Browsers that only
        // ever return one alternative simply ignore this; scoring then
        // falls back to the single transcript as before. Only the
        // transcripts (text) are kept — the recording never leaves the
        // device for scoring.
        try {
          rec.maxAlternatives = 5;
        } catch {
          // Some implementations expose it read-only; one alternative
          // is still usable.
        }
        rec.onresult = (event) => {
          let interim = "";
          for (let k = event.resultIndex; k < event.results.length; k++) {
            const item = event.results[k];
            if (!item) continue;
            const best = item[0]?.transcript ?? "";
            if (item.isFinal) {
              const alts: string[] = [];
              const altCount =
                typeof item.length === "number" && item.length > 0 ? item.length : 1;
              for (let a = 0; a < altCount; a++) {
                const tr = item[a]?.transcript?.trim();
                if (tr) alts.push(tr);
              }
              if (alts.length === 0 && best.trim()) alts.push(best.trim());
              if (alts.length > 0) finalSegmentsRef.current.push(alts);
              finalHeardRef.current = `${finalHeardRef.current} ${best}`.trim();
            } else {
              interim += best;
            }
          }
          setLiveHeard(`${finalHeardRef.current} ${interim}`.trim());
        };
        rec.onerror = () => {
          // Keep recording audio even if recognition hiccups; the empty
          // transcript path below explains what happened.
        };
        rec.start();
        recognitionRef.current = rec;
      } catch {
        recognitionRef.current = null;
      }
    }

    setElapsed(0);
    setPhase("recording");
    timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
  }

  function stopRecording() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // already stopped
    }
    recognitionRef.current = null;
    recorderRef.current?.stop();
  }

  /** Cancel a take in progress: stops the mic and recognizer and discards
   *  the recording without scoring it. Also works while scoring is in
   *  flight — the mutation's callbacks then drop the attempt. */
  function cancelAttempt() {
    if (phase !== "recording" && phase !== "scoring") return;
    cancelledRef.current = true;
    if (phase === "scoring") {
      // The recorder already stopped; the scoring callbacks discard the
      // attempt when the request settles.
      setInfoMsg("キャンセルしています…");
      return;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    try {
      if (rec?.abort) rec.abort();
      else rec?.stop();
    } catch {
      // already stopped
    }
    try {
      recorderRef.current?.stop();
    } catch {
      // already inactive; nothing will fire onstop, so clean up here
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      cancelledRef.current = false;
      chunksRef.current = [];
      finalHeardRef.current = "";
      finalSegmentsRef.current = [];
      resetAttemptState();
      setInfoMsg("キャンセルしました。録音と採点は中止されました。");
    }
  }

  function handleRecorderStop() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (cancelledRef.current) {
      // Cancelled take: throw the audio and transcript away, no scoring.
      cancelledRef.current = false;
      chunksRef.current = [];
      finalHeardRef.current = "";
      finalSegmentsRef.current = [];
      recordingBlobRef.current = null;
      resetAttemptState();
      setInfoMsg("キャンセルしました。録音と採点は中止されました。");
      return;
    }
    const recorder = recorderRef.current;
    const blob = new Blob(chunksRef.current, {
      type: recorder?.mimeType || "audio/webm",
    });
    recordingBlobRef.current = blob.size > 0 ? blob : null;
    if (blob.size > 0) setRecordingUrl(URL.createObjectURL(blob));

    const heard = finalHeardRef.current.trim();
    if (!recognitionSupported) {
      setPhase("recordedOnly");
      return;
    }
    if (!heard) {
      setError("音声が認識できませんでした。静かな場所で、もう少し大きな声で読んでみてください。");
      setPhase("idle");
      return;
    }
    setPhase("scoring");
    // Widen the match: send every candidate transcript the browser
    // offered (combinations of the per-segment alternatives) and let
    // the server score against the one closest to the target, so a
    // word the learner did say is not counted as a mistake just
    // because the recognizer's first guess missed it.
    const heardCandidates = buildCandidateTranscripts(finalSegmentsRef.current);
    recordMutation.mutate({
      target,
      heard,
      heardCandidates: heardCandidates.length > 0 ? heardCandidates : undefined,
    });
  }

  function reuseAttempt(text: string) {
    if (busy) return;
    setCustomText(text);
    resetAttemptState();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const busy = phase === "recording" || phase === "scoring";

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-10">
        <p className="pt-5 text-sm leading-relaxed text-[var(--dim)]">
          外部の音源でお手本を聞いたら、その英文を下に入力して録音。あなたの声が単語ごとに通じたかをチェックします。採点は単語レベルの目安です。
        </p>

        {!recognitionSupported && (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--record-soft)] px-3 py-2 text-sm leading-relaxed text-[var(--ng-text)]">
            このブラウザでは音声認識が使えないため、採点はできません。読み上げと、録音・自分の声の再生のみ利用できます。
          </p>
        )}

        {/* Practice panel */}
        <section aria-label="練習" className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-center gap-2">
            <label htmlFor="custom-sentence" className="text-sm font-medium">
              練習したい英文
            </label>
            {currentBest !== undefined && (
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                ベスト {currentBest}点
              </span>
            )}
          </div>
          <textarea
            id="custom-sentence"
            {...FIELDS.recordAttempt.target}
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              resetAttemptState();
            }}
            rows={3}
            placeholder="例: I will call you when I get home."
            className="mt-2 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-lg outline-none focus:border-[var(--accent)]"
            style={{ fontFamily: SERIF }}
          />
          <p className="mt-1 text-xs text-[var(--dim)]">
            外部音源の英文をそのまま入力してください。「お手本を聞く」は端末の読み上げ機能で再生されます。入力すると、音の変化（連結・消失・フラップ・弱形）の候補が下に表示されます。入力中の英文はこの端末に自動保存され、次回開いたときに復元されます。
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={saveCurrentText}
              disabled={busy || !target || isCurrentTextSaved}
              className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              aria-label="入力した英文を保存する"
            >
              {isCurrentTextSaved ? "保存済み" : "この英文を保存"}
            </button>
            <button
              type="button"
              onClick={clearPracticeText}
              disabled={busy || !customText}
              className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--dim)] disabled:opacity-40"
              aria-label="入力した英文をクリアする"
            >
              クリア
            </button>
            <span className="text-xs text-[var(--dim)]">保存先はこの端末のブラウザです</span>
          </div>

          {savedTexts.length > 0 && (
            <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">保存済みの英文</h3>
                {confirmClearSaved ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={clearAllSavedTexts}
                      className="rounded-full bg-[var(--record)] px-3 py-1.5 text-xs font-semibold text-white"
                      aria-label="保存済みの英文をすべて削除する（確認）"
                    >
                      本当に全件削除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClearSaved(false)}
                      className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs"
                      aria-label="保存済みの英文の全件削除をキャンセル"
                    >
                      キャンセル
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmClearSaved(true)}
                    className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)]"
                    aria-label="保存済みの英文をすべて削除"
                  >
                    すべて削除
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-[var(--dim)]">
                タップすると入力欄に呼び出せます。保存はこの端末のみで、最大{SAVED_TEXTS_LIMIT}件です。
              </p>
              <ul className="mt-2 space-y-2">
                {savedTexts.map((text) => (
                  <li
                    key={text}
                    className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => loadSavedText(text)}
                      disabled={busy}
                      className="min-w-0 flex-1 text-left text-base disabled:opacity-40"
                      style={{ fontFamily: SERIF }}
                      aria-label={`保存済みの英文「${text}」を入力欄に呼び出す`}
                    >
                      {text}
                      {text === target && (
                        <span className="ml-2 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 align-middle text-xs font-medium text-[var(--accent)]">
                          表示中
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSavedText(text)}
                      disabled={busy}
                      className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--dim)] disabled:opacity-40"
                      aria-label={`保存済みの英文「${text}」を削除`}
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {target &&
            (candidates.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--dim)]">
                この文では、連結・消失・フラップ・弱形の候補は見つかりませんでした。
              </p>
            ) : (
              <div className="mt-4 rounded-[var(--radius)] bg-[var(--bg)] px-3 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="mr-1 text-sm font-semibold">音の変化の候補</h3>
                  {KIND_ORDER.filter((k) => candidateCounts.has(k)).map((k) => (
                    <span
                      key={k}
                      className="rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{ color: KIND_META[k].color, backgroundColor: KIND_META[k].bg }}
                    >
                      {KIND_META[k].label} {candidateCounts.get(k)}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-lg leading-relaxed" style={{ fontFamily: SERIF }}>
                  {renderAnnotated()}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {candidates.map((c, idx) => {
                    const status = candidateStatus(c);
                    return (
                      <li key={`${c.kind}-${c.tokenIndexes.join("-")}-${idx}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold"
                          style={{ color: KIND_META[c.kind].color, backgroundColor: KIND_META[c.kind].bg }}
                        >
                          {KIND_META[c.kind].label}
                        </span>
                        <span style={{ fontFamily: SERIF }}>{c.phrase}</span>
                        <span className="text-xs text-[var(--dim)]">{c.detail}</span>
                        {status === "passed" && (
                          <span className="rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-xs font-medium text-[var(--ok-text)]">
                            通じた可能性あり
                          </span>
                        )}
                        {status === "check" && (
                          <span className="rounded-full bg-[var(--ng-bg)] px-2 py-0.5 text-xs font-medium text-[var(--ng-text)]">
                            要確認
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                  候補は綴りからの推定です。実際に音が変化したかまでは判定できません。録音後の「通じた可能性あり」は、候補の単語が認識されたかどうかの目安です。
                </p>
              </div>
            ))}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={playModel}
              disabled={busy}
              className="rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-40"
              aria-label="入力した英文を読み上げて再生"
            >
              ▶ お手本を聞く
            </button>
            {phase !== "recording" ? (
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={phase === "scoring"}
                className="rounded-full bg-[var(--record)] px-6 py-3 text-base font-semibold text-white disabled:opacity-40"
                aria-label="録音を開始"
              >
                ● 録音する
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="rounded-full bg-[var(--record)] px-6 py-3 text-base font-semibold text-white"
                  aria-label="録音を停止して採点"
                >
                  ■ 停止して採点（{elapsed}秒）
                </button>
                <button
                  type="button"
                  onClick={cancelAttempt}
                  className="rounded-full border border-[var(--border)] px-5 py-3 text-base font-medium text-[var(--dim)]"
                  aria-label="録音をキャンセルして採点を中止"
                >
                  ✕ キャンセル
                </button>
              </>
            )}
          </div>

          {phase === "recording" && (
            <div className="mt-4 rounded-[var(--radius)] bg-[var(--bg)] px-3 py-2">
              <p className="flex items-center gap-2 text-sm font-medium text-[var(--record)]">
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--record)]" />
                録音中… 文を読んでください
              </p>
              {liveHeard && (
                <p className="mt-1 text-sm text-[var(--dim)]" style={{ fontFamily: SERIF }}>
                  {liveHeard}
                </p>
              )}
            </div>
          )}

          {phase === "scoring" && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-[var(--dim)]">採点中…</p>
              <button
                type="button"
                onClick={cancelAttempt}
                className="rounded-full border border-[var(--border)] px-4 py-1.5 text-sm font-medium text-[var(--dim)]"
                aria-label="採点をキャンセルして中止"
              >
                ✕ キャンセル
              </button>
            </div>
          )}

          {infoMsg && (
            <p className="mt-4 rounded-[var(--radius)] bg-[var(--accent-soft)] px-3 py-2 text-sm leading-relaxed">
              {infoMsg}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-[var(--radius)] bg-[var(--record-soft)] px-3 py-2 text-sm text-[var(--ng-text)]">
              {error}
            </p>
          )}

          {phase === "recordedOnly" && (
            <p className="mt-4 text-sm text-[var(--dim)]">
              録音できました。下のプレーヤーで自分の声を確認できます（このブラウザでは採点できません）。
            </p>
          )}

          {recordingUrl && phase !== "recording" && (
            <div className="mt-4">
              <p className="text-sm font-medium">自分の声</p>
              <audio controls src={recordingUrl} className="mt-1 w-full" aria-label="自分の録音を再生" />
            </div>
          )}

          {phase === "done" && result && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-bold text-[var(--accent)]">{result.score}</span>
                <span className="text-sm text-[var(--dim)]">/ 100 点</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5" aria-label="単語ごとの結果">
                {result.words.map((w, idx) => (
                  <span
                    key={`${w.word}-${idx}`}
                    className="rounded-md px-2 py-1 text-base"
                    style={{
                      fontFamily: SERIF,
                      backgroundColor: w.status === "ok" ? "var(--ok-bg)" : "var(--ng-bg)",
                      color: w.status === "ok" ? "var(--ok-text)" : "var(--ng-text)",
                      textDecoration: w.status === "missing" ? "line-through" : undefined,
                    }}
                    title={
                      w.status === "ok"
                        ? "通じました"
                        : w.status === "wrong"
                          ? `「${w.heard ?? ""}」と聞き取られました`
                          : "聞き取れませんでした"
                    }
                  >
                    {w.word}
                    {w.status === "wrong" && w.heard && (
                      <span className="ml-1 text-xs">→ {w.heard}</span>
                    )}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-sm text-[var(--dim)]">
                認識された文: <span style={{ fontFamily: SERIF }}>{result.heard}</span>
              </p>
              {result.feedback && (
                <p className="mt-2 rounded-[var(--radius)] bg-[var(--accent-soft)] px-3 py-2 text-sm leading-relaxed">
                  {result.feedback}
                </p>
              )}

              {/* Notion export (opt-in) */}
              <div className="mt-4 rounded-[var(--radius)] bg-[var(--bg)] px-3 py-3">
                {result.notion_page_url ? (
                  <p className="text-sm leading-relaxed">
                    <span className="font-semibold">Notionに保存済み</span>
                    {result.notion_parent_title && (
                      <span className="text-[var(--dim)]">（保存先: {result.notion_parent_title}）</span>
                    )}
                    <a
                      href={result.notion_page_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 font-medium text-[var(--accent)] underline"
                    >
                      ページを開く
                    </a>
                  </p>
                ) : (
                  <>
                    <label className="flex items-start gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={wantNotion}
                        onChange={(e) => setWantNotion(e.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                      <span>この結果と録音音声をNotionに保存する</span>
                    </label>
                    {wantNotion && (
                      <div className="mt-3 space-y-3">
                        <div>
                          <label htmlFor="notion-dest" className="text-sm font-medium">
                            保存先ページ
                          </label>
                          <select
                            id="notion-dest"
                            value={effectiveDestId}
                            onChange={(e) => setSelectedDest(e.target.value)}
                            className="mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base outline-none focus:border-[var(--accent)]"
                          >
                            {destinations.map((d) => (
                              <option key={d.pageId} value={d.pageId}>
                                {d.title}
                                {d.path ? `（${d.path}）` : ""}
                                {d.isDefault ? "・既定" : ""}
                              </option>
                            ))}
                            <option value="__draft__">指定しない（プライベートページ）</option>
                          </select>
                          {destinations.length === 0 && !searchDestMutation.isPending && (
                            <p className="mt-1 text-xs text-[var(--dim)]">
                              保存先はまだ登録されていません。下の検索からページを追加してください。
                            </p>
                          )}
                          {searchDestMutation.isPending && (
                            <p className="mt-1 text-xs text-[var(--dim)]">保存先を検索中…</p>
                          )}
                          {effectiveDestId !== "__draft__" &&
                            destinations.find((d) => d.pageId === effectiveDestId)?.isDefault !== true && (
                              <button
                                type="button"
                                onClick={() => setDefaultDestination(effectiveDestId)}
                                className="mt-1 text-xs font-medium text-[var(--accent)] underline"
                                aria-label="選択中の保存先を既定にする"
                              >
                                この保存先を既定にする
                              </button>
                            )}
                        </div>
                        <div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              {...FIELDS.searchNotionPages.query}
                              value={destQuery}
                              onChange={(e) => {
                                setDestQuery(e.target.value);
                                setDestQueryError(null);
                              }}
                              placeholder="ページ名で検索"
                              aria-label="Notionの保存先をページ名で検索"
                              className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base outline-none focus:border-[var(--accent)]"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const q = destQuery.trim();
                                if (!q) {
                                  setDestQueryError("検索するページ名を入力してください。");
                                  return;
                                }
                                setDestQueryError(null);
                                searchDestMutation.mutate(q);
                              }}
                              disabled={searchDestMutation.isPending}
                              className="shrink-0 rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-40"
                              aria-label="保存先を検索"
                            >
                              検索
                            </button>
                          </div>
                          {destQueryError && (
                            <p role="alert" className="mt-1 text-xs text-[var(--ng-text)]">
                              {destQueryError}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-[var(--dim)]">
                            保存先のリストはこの端末のブラウザに保存されます（サーバーには保存されません）。
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void saveResultToNotion()}
                          disabled={saveNotionMutation.isPending}
                          className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                          aria-label="結果と録音音声をNotionに保存"
                        >
                          {saveNotionMutation.isPending ? "Notionに保存中…" : "Notionに保存"}
                        </button>
                        <p className="text-xs leading-relaxed text-[var(--dim)]">
                          保存すると、選んだページの配下に結果ページが作られ、録音音声ファイルが添付されます。保存を選ばない限り、音声が端末の外に出ることはありません。
                        </p>
                      </div>
                    )}
                    {notionMsg && (
                      <p role="alert" className="mt-2 text-sm leading-relaxed text-[var(--ng-text)]">
                        {notionMsg}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {/* History */}
        <section aria-label="練習履歴" className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">練習履歴</h2>
            {attempts.length > 0 &&
              (confirmClear ? (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => clearMutation.mutate()}
                    className="rounded-full bg-[var(--record)] px-3 py-1.5 text-xs font-semibold text-white"
                    aria-label="履歴をすべて削除する（確認）"
                  >
                    本当に全件削除
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs"
                    aria-label="全件削除をキャンセル"
                  >
                    キャンセル
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)]"
                  aria-label="履歴をすべて削除"
                >
                  全件削除
                </button>
              ))}
          </div>

          {historyNotionMsg && (
            <p className="mt-3 rounded-[var(--radius)] bg-[var(--accent-soft)] px-3 py-2 text-sm leading-relaxed">
              {historyNotionMsg}
            </p>
          )}

          {attemptsQuery.isPending ? (
            <p className="mt-3 text-sm text-[var(--dim)]">読み込み中…</p>
          ) : attempts.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">
              まだ履歴がありません。英文を入力して録音すると、ここに結果が残ります。
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {attempts.map((a) => (
                <li
                  key={a.id}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="shrink-0 rounded-full px-2.5 py-1 text-sm font-bold"
                      style={{
                        backgroundColor: a.score >= 80 ? "var(--ok-bg)" : "var(--ng-bg)",
                        color: a.score >= 80 ? "var(--ok-text)" : "var(--ng-text)",
                      }}
                    >
                      {a.score}点
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base" style={{ fontFamily: SERIF }}>
                        {a.target}
                      </span>
                      <span className="block truncate text-xs text-[var(--dim)]" style={{ fontFamily: SERIF }}>
                        認識: {a.heard}
                      </span>
                      <span className="block text-xs text-[var(--dim)]">
                        {new Date(a.created_at).toLocaleString("ja-JP", {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {a.notion_page_url ? (
                        <span className="block text-xs">
                          <a
                            href={a.notion_page_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-[var(--accent)] underline"
                          >
                            Notionに保存済み{a.notion_parent_title ? `（${a.notion_parent_title}）` : ""}
                          </a>
                        </span>
                      ) : (
                        <span className="block">
                          <button
                            type="button"
                            onClick={() => saveHistoryToNotion(a)}
                            disabled={saveNotionMutation.isPending}
                            className="text-xs font-medium text-[var(--accent)] underline disabled:opacity-40"
                            aria-label={`履歴「${a.target}」をNotionに保存（音声なし）`}
                          >
                            {saveNotionMutation.isPending &&
                            saveNotionMutation.variables?.attemptId === a.id
                              ? "Notionに保存中…"
                              : "Notionに保存（音声なし・既定の保存先）"}
                          </button>
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => reuseAttempt(a.target)}
                      className="shrink-0 rounded-full border border-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]"
                      aria-label={`履歴「${a.target}」の英文でもう一度練習`}
                    >
                      もう一度
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(a.id)}
                      className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--dim)]"
                      aria-label={`履歴「${a.target}」を削除`}
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-8 text-xs leading-relaxed text-[var(--dim)]">
          録音した音声は端末の中だけで再生され、通常はサーバーに送られません。結果画面で「Notionに保存」を選んだ場合に限り、その回の結果と音声がNotionへ送信されます。履歴には入力した英文・認識された文・スコアだけが保存されます。
        </p>
      </main>
    </div>
  );
}
