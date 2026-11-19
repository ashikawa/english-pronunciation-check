// useRecordingSession — the whole recording / recognition lifecycle.
//
// IMPORTANT: this hook is deliberately ONE file and must stay that
// way. The recorder, the SpeechRecognition sessions, the restart
// logic, the settled-signal waits, and the cancel path are tightly
// coupled through the refs below; the v13–v21 fix history (see
// DATA-PLAN.md) is a chain of bugs caused exactly by these paths
// drifting apart. Do not split the session internals across files.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "../api";
import {
  emptyRecognitionError,
  emptyRecognitionNote,
  emptyRecognitionSummary,
  earlyEndGiveUpDiag,
  prevSessionTimeoutDiag,
  prevSessionWaitingDiag,
  PREV_SESSION_TIMEOUT_ERROR,
  recognitionErrorDiag,
  recognitionStartFailedDiag,
  RECOGNITION_START_FAILED_ERROR,
  restartFailedDiag,
  restartLimitDiag,
  settleTimeoutDiag,
} from "../lib/messages";
import {
  buildCandidateTranscripts,
  createSettledSignal,
  getRecognitionCtor,
  EARLY_END_MS,
  MAX_EARLY_FAILURES,
  MAX_RECOGNITION_RESTARTS,
  PREV_SESSION_WAIT_CAP_MS,
  type Phase,
  type SRLike,
  type SRCtor,
} from "../lib/speech";
import { FAILURE_LOG_LIMIT } from "../lib/storage";

export type Attempt = ApiResponse<typeof api, "recordAttempt">;

export interface RecordingSessionOptions {
  /** The current practice text (trimmed). Read at take start / scoring. */
  target: string;
  /** Called when a take ends with an empty transcript, with the
   *  diagnostic summary, so the caller can append it to the
   *  persistent failure log. */
  onRecognitionFailure: (summary: string) => void;
  /** Extra reset work run at the end of resetAttemptState (the App
   *  uses it to clear the Notion export UI state, as before). */
  onReset?: () => void;
}

export function useRecordingSession(options: RecordingSessionOptions) {
  const queryClient = useQueryClient();
  const { target } = options;
  const onResetRef = useRef(options.onReset);
  onResetRef.current = options.onReset;
  const onFailureRef = useRef(options.onRecognitionFailure);
  onFailureRef.current = options.onRecognitionFailure;

  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<Attempt | null>(null);
  const [liveHeard, setLiveHeard] = useState("");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest speech-recognition problem, kept on screen in readable
  // form (including the browser's own error code) until the next take
  // starts or one completes cleanly, so a failure can be reported
  // exactly as it appeared instead of being swallowed. Deliberately
  // NOT cleared by resetAttemptState: it must survive the cancel /
  // reset paths that follow the failure it describes.
  const [recDiag, setRecDiag] = useState<string | null>(null);
  // True when the last take ended with an empty transcript. The UI
  // then offers a recognition reset (page reload) next to the error
  // message: reloading is the only in-page recovery when the
  // browser's recognizer itself is wedged, and everything the user
  // typed or saved lives in localStorage / the server history, so a
  // reload loses nothing.
  const [emptyRecognition, setEmptyRecognition] = useState(false);
  // The empty take's diagnostic summary plus a plain-language reading
  // of it (mic-side vs recognizer-side), rendered INSIDE the error
  // frame so the whole report is in one place to copy and send.
  const [emptyDiag, setEmptyDiag] = useState<{ summary: string; note: string | null } | null>(null);
  // Live mic input level (0..1) while recording, from the analyser
  // monitor; shown as a small meter so the user can see their voice
  // is reaching the microphone.
  const [micLevel, setMicLevel] = useState(0);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [recognitionSupported] = useState(() => getRecognitionCtor() !== null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingBlobRef = useRef<Blob | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SRLike | null>(null);
  // Recognition lifecycle for the current take. A session ends
  // asynchronously: its final results arrive just before `onend`,
  // after `stop()` has already returned. `recognitionSettledRef`
  // resolves only once recognition has been ASKED to stop and the
  // last session has ended (mid-take restarts do not resolve it);
  // scoring waits for it so the last words are not lost, and the next
  // take waits for it before starting a new session — starting while
  // the old session is still shutting down throws.
  const recognitionSettledRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  // True while the current take wants recognition running. A session
  // that ends on its own mid-take (long pause, transient network
  // drop) is restarted while this is true; stop/cancel set it false.
  const recognitionActiveRef = useRef(false);
  // True once recognition hit an error restarting cannot fix
  // (permission, mic capture): the session is left ended.
  const recognitionFatalRef = useRef(false);
  const recognitionRestartsRef = useRef(0);
  // Consecutive sessions that ended immediately after starting
  // without a single result. Past the cap the take stops pretending
  // recognition is running and reports the failure instead.
  const earlyFailuresRef = useRef(0);
  // Detail of the last synchronous recognition start() failure, kept
  // so the on-screen message can name it.
  const recognitionStartErrorRef = useRef<string | null>(null);
  // Take-level recognition diagnostics. When a take ends with an
  // empty transcript and no error code — the browser's recognizer
  // simply returned nothing — these are the only facts available for
  // telling a wedged recognizer apart from a quiet room, so the stop
  // path always renders them into the on-screen diagnostic line.
  const sessionCountRef = useRef(0);
  const anyResultRef = useRef(false);
  const takeStartedAtRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  // Take lifecycle: "none" → "starting" → "recording" → "stopping".
  // Guards start/stop/cancel against double operation and lets async
  // continuations tell whether their take is still the current one.
  const takeStateRef = useRef<"none" | "starting" | "recording" | "stopping">("none");
  const takeIdRef = useRef(0);
  // Set once the current take's recorder-stop handling has run, so a
  // manually invoked fallback cannot run it a second time.
  const stopHandledRef = useRef(true);
  // Last recognition error code for the current take (e.g. "network",
  // "not-allowed"). Kept so an empty transcript can explain WHY
  // recognition failed instead of only saying nothing was heard.
  const recognitionErrorRef = useRef<string | null>(null);
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
  // Mic level monitor: an AnalyserNode tapped off the same mic stream
  // the recorder uses. It measures the input level only — nothing is
  // recorded or sent anywhere — so an empty-recognition take can be
  // attributed: a healthy peak means the voice reached the microphone
  // and the browser's recognizer returned nothing; a near-zero peak
  // means the voice never reached the mic.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micMonitorTimerRef = useRef<number | null>(null);
  const micPeakRef = useRef<number | null>(null);
  // Latest recordingUrl, for revoking in resetAttemptState without
  // making that function depend on render-scope state identity.
  const recordingUrlRef = useRef<string | null>(null);
  recordingUrlRef.current = recordingUrl;

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
      setRecDiag(null);
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

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (micMonitorTimerRef.current !== null) window.clearInterval(micMonitorTimerRef.current);
      const audioCtx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (audioCtx) void audioCtx.close().catch(() => undefined);
      recognitionActiveRef.current = false;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // already ended
      }
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  function resetAttemptState() {
    setResult(null);
    setLiveHeard("");
    setError(null);
    setEmptyRecognition(false);
    setEmptyDiag(null);
    setInfoMsg(null);
    setPhase("idle");
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    setRecordingUrl(null);
    recordingBlobRef.current = null;
    onResetRef.current?.();
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

  function stopElapsedTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function clearRestartTimer() {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }

  /** Start measuring the mic input level for this take. Best-effort:
   *  if the Web Audio API is unavailable the peak stays null and the
   *  diagnostics say 計測できず instead of guessing. */
  function startMicMonitor(stream: MediaStream) {
    stopMicMonitor();
    micPeakRef.current = 0;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        micPeakRef.current = null;
        return;
      }
      const ctx = new Ctor();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      micMonitorTimerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs((buf[i] ?? 128) - 128) / 128;
          if (v > peak) peak = v;
        }
        if (micPeakRef.current !== null && peak > micPeakRef.current) {
          micPeakRef.current = peak;
        }
        setMicLevel(peak);
      }, 200);
      void ctx.resume().catch(() => undefined);
    } catch {
      micPeakRef.current = null;
    }
  }

  /** Stop the mic level monitor. The peak value is kept in its ref so
   *  the stop path can still read it after the monitor is gone. */
  function stopMicMonitor() {
    if (micMonitorTimerRef.current !== null) {
      window.clearInterval(micMonitorTimerRef.current);
      micMonitorTimerRef.current = null;
    }
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
    setMicLevel(0);
  }

  /** Discard a cancelled take: throw the audio and transcript away, clear
   *  the per-take refs, and return to the initial state. Nothing is
   *  scored and nothing is stored.
   *
   *  The recognition settled signal is deliberately KEPT, unlike the
   *  other refs: `abort()` ends a session asynchronously, so the old
   *  session may still be shutting down when the UI is already back to
   *  idle. The next take's `startRecording` awaits this signal before
   *  starting a new session; discarding it here (as this function used
   *  to) let the next take call `start()` while the old session was
   *  still ending, which throws and leaves the take unrecognized. The
   *  signal resolves from the old session's own `onend` (each session
   *  captures its take's signal), or immediately in `cancelAttempt`
   *  when no session is live anymore. `startRecording` waits for that
   *  real end however long it takes; only past a 20-second hard cap
   *  does it give up — and then it aborts the new take with the
   *  reason on screen rather than starting over the old session. */
  function discardCancelledTake() {
    cancelledRef.current = false;
    recognitionActiveRef.current = false;
    clearRestartTimer();
    stopMicMonitor();
    recognitionRef.current = null;
    recorderRef.current = null;
    takeStateRef.current = "none";
    // The take is fully handled here; a late recorder `onstop` for it
    // must not go on to score anything.
    stopHandledRef.current = true;
    chunksRef.current = [];
    finalHeardRef.current = "";
    finalSegmentsRef.current = [];
    recordingBlobRef.current = null;
    resetAttemptState();
    setInfoMsg("キャンセルしました。録音と採点は中止されました。");
  }

  /**
   * Start one recognition session for the current take and wire its
   * handlers. Returns false when the session could not be started.
   *
   * A session can end on its own mid-take (a long pause, a sentence
   * boundary, a transient network drop): `onend` then restarts it
   * while the take is still recording, so the rest of the take is
   * still heard — the accumulated transcript lives in refs outside
   * the session, so a restart loses nothing. The guarantee `onend`
   * implements is that EVERY mid-take session end is accounted for:
   * it either schedules a restart, or recognition is marked fatal
   * with the reason left on screen (fatal errors such as permission
   * or mic capture, repeated failed starts, an exhausted restart
   * budget). No end path leaves the take silently unrecognized.
   * The take's settled signal resolves only once recognition has been
   * asked to stop AND the last session has ended, which is what the
   * scoring path waits for.
   *
   * A session that ends immediately after starting, without a single
   * result, is a failed start, not a healthy pause: it is retried a
   * few times, and then the take gives up on recognition and leaves
   * the reason (with the error code) on screen, instead of looping
   * restarts silently while the user believes they are being heard.
   */
  function beginRecognition(Ctor: SRCtor, takeId: number): boolean {
    let rec: SRLike;
    // This session belongs to one take: it captures that take's settled
    // signal and resolves only that one when it ends. A late `onend`
    // from a previous take's session must never release the current
    // take's scoring wait, and its late results/errors must never leak
    // into the current take's transcript — the handlers below check
    // the take id for exactly that.
    const settledSignal = recognitionSettledRef.current;
    // Per-session health tracking for the failed-start detection in
    // `onend`: when this session started, and whether it ever
    // produced a result.
    const startedAt = Date.now();
    let hadResult = false;
    try {
      rec = new Ctor();
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
        // Late results from a previous take's session (still shutting
        // down after a cancel) are not this take's words.
        if (takeIdRef.current !== takeId) return;
        hadResult = true;
        anyResultRef.current = true;
        // A session that is producing results is healthy; allow it a
        // fresh restart budget if it ends later.
        recognitionRestartsRef.current = 0;
        earlyFailuresRef.current = 0;
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
      rec.onerror = (event) => {
        // A previous take's session reporting late (e.g. its own
        // "aborted") must not poison this take's error state.
        if (takeIdRef.current !== takeId) return;
        // Remember why recognition failed for this take: if the
        // transcript ends up empty, the stop path shows this instead
        // of only the generic "not recognized" message. Recording
        // itself continues — the audio is a separate path and stays
        // playable either way.
        if (event.error && event.error !== "aborted") {
          recognitionErrorRef.current = event.error;
          // Keep the failure readable on screen, with the browser's
          // own error code, so it can be reported as-is.
          setRecDiag(recognitionErrorDiag(event.error));
          if (
            event.error === "not-allowed" ||
            event.error === "service-not-allowed" ||
            event.error === "audio-capture"
          ) {
            // Restarting cannot fix these; let the session end.
            recognitionFatalRef.current = true;
          }
        }
      };
      rec.onend = () => {
        if (recognitionRef.current === rec) recognitionRef.current = null;
        if (!recognitionActiveRef.current) {
          // Recognition was asked to stop (停止 / キャンセル). Resolve
          // only THIS take's signal (captured when the session
          // started), never whatever signal the ref holds by now: a
          // newer take may already have installed its own.
          settledSignal?.resolve();
          return;
        }
        // From here on the take still wants recognition, so this
        // session end must lead somewhere visible: a scheduled
        // restart, or — when restarting cannot help — recognition
        // marked fatal with the reason left on screen. A session end
        // that does neither is how a take loses its second half
        // silently: the recognizer stops at a pause or a sentence
        // boundary (the browser service ends sessions there, not
        // only at a length limit) and nothing ever starts it again,
        // while the recorder keeps running and the user keeps
        // reading. The branches below are ordered so every end is
        // accounted for.
        const inTake =
          (takeStateRef.current === "recording" || takeStateRef.current === "starting") &&
          takeIdRef.current === takeId;
        if (!inTake) {
          // This take is already being torn down by another path;
          // that path owns what happens next.
          return;
        }
        if (recognitionFatalRef.current) {
          // A fatal error (permission, mic capture, a failed restart,
          // an earlier give-up) already left its reason on screen;
          // restarting cannot fix it, so the session stays ended.
          // The settled signal is NOT resolved here: the take is
          // still active, and the stop path releases the wait when
          // the user ends the take.
          return;
        }
        // Failed start: this session died immediately, without a
        // single result, while the take still wants recognition.
        // Retry a few times; past the cap, stop looping — mark
        // recognition fatal for this take and leave the reason (with
        // the error code) on screen.
        const diedEarly = !hadResult && Date.now() - startedAt < EARLY_END_MS;
        if (diedEarly) {
          earlyFailuresRef.current += 1;
          if (earlyFailuresRef.current >= MAX_EARLY_FAILURES) {
            recognitionFatalRef.current = true;
            if (!recognitionErrorRef.current) recognitionErrorRef.current = "early-end";
            setRecDiag(earlyEndGiveUpDiag(recognitionErrorRef.current));
            return;
          }
          restartTimerRef.current = window.setTimeout(() => {
            restartTimerRef.current = null;
            if (
              recognitionActiveRef.current &&
              !recognitionFatalRef.current &&
              (takeStateRef.current === "recording" || takeStateRef.current === "starting") &&
              takeIdRef.current === takeId
            ) {
              if (!beginRecognition(Ctor, takeId)) {
                recognitionFatalRef.current = true;
                setRecDiag(
                  restartFailedDiag(recognitionStartErrorRef.current ?? "start failed"),
                );
              }
            }
          }, 800);
          return;
        }
        if (recognitionRestartsRef.current >= MAX_RECOGNITION_RESTARTS) {
          // The restart budget is spent. Any result resets it, so
          // reaching the cap means many sessions in a row ended
          // without hearing anything. Give up — but say so on screen
          // instead of leaving the rest of the take unrecognized
          // with no explanation.
          recognitionFatalRef.current = true;
          if (!recognitionErrorRef.current) recognitionErrorRef.current = "restart-limit";
          setRecDiag(
            restartLimitDiag(MAX_RECOGNITION_RESTARTS, recognitionErrorRef.current),
          );
          return;
        }
        recognitionRestartsRef.current += 1;
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          if (
            recognitionActiveRef.current &&
            !recognitionFatalRef.current &&
            (takeStateRef.current === "recording" || takeStateRef.current === "starting") &&
            takeIdRef.current === takeId
          ) {
            if (!beginRecognition(Ctor, takeId)) {
              recognitionFatalRef.current = true;
              setRecDiag(
                restartFailedDiag(recognitionStartErrorRef.current ?? "start failed"),
              );
            }
          }
        }, 300);
      };
      rec.start();
    } catch (e) {
      recognitionStartErrorRef.current =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return false;
    }
    recognitionRef.current = rec;
    sessionCountRef.current += 1;
    return true;
  }

  async function startRecording() {
    // Double-start guard: a second call while a take is starting,
    // recording, or stopping would create competing recorder /
    // recognition sessions whose refs overwrite each other, leaving
    // one of them running unwatched.
    if (takeStateRef.current !== "none") return;
    setError(null);
    setInfoMsg(null);
    setRecDiag(null);
    setEmptyRecognition(false);
    setEmptyDiag(null);
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
    takeStateRef.current = "starting";
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      takeStateRef.current = "none";
      setPhase("idle");
      setError("マイクの使用が許可されませんでした。ブラウザの設定でマイクを許可してください。");
      return;
    }
    if (takeStateRef.current !== "starting") {
      // The take was abandoned while waiting for the mic.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    finalHeardRef.current = "";
    finalSegmentsRef.current = [];
    stopHandledRef.current = false;
    setLiveHeard("");
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    setRecordingUrl(null);
    recordingBlobRef.current = null;

    // Start recognition BEFORE the recorder, and wait for the previous
    // take's recognition to fully end first. A SpeechRecognition
    // session ends asynchronously (its final results and `onend`
    // arrive after `stop()` returns); starting a new session while the
    // old one is still shutting down throws InvalidStateError. That
    // throw used to be swallowed, so a second take could show 録音中
    // with no live recognition behind it and come back empty.
    const takeId = takeIdRef.current + 1;
    takeIdRef.current = takeId;
    const Ctor = getRecognitionCtor();
    if (Ctor) {
      const prevSignal = recognitionSettledRef.current;
      if (prevSignal) {
        // Wait until the previous session has ACTUALLY ended: the
        // signal resolves only from that session's own `onend` (or an
        // explicit resolve when no session was live anymore). An
        // earlier version gave up after 2 s and started anyway — but
        // with a long practice text the aborted session can still be
        // shutting down well past that, and `start()` over a session
        // that is still ending throws, leaving the new take with no
        // live recognition. There is deliberately no "start anyway"
        // path anymore: past the hard cap the take is aborted with
        // the reason on screen, and the signal is kept so the next
        // attempt waits for the same session again.
        const waitStartedAt = Date.now();
        let announced = false;
        let settled = false;
        while (!settled) {
          settled = await Promise.race([
            prevSignal.promise.then(() => true),
            new Promise<boolean>((r) => window.setTimeout(() => r(false), 250)),
          ]);
          if (settled) break;
          const waited = Date.now() - waitStartedAt;
          if (!announced && waited >= 1500) {
            announced = true;
            setRecDiag(prevSessionWaitingDiag());
          }
          if (waited >= PREV_SESSION_WAIT_CAP_MS) break;
        }
        if (!settled) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          takeStateRef.current = "none";
          setPhase("idle");
          setRecDiag(
            prevSessionTimeoutDiag(Math.round(PREV_SESSION_WAIT_CAP_MS / 1000)),
          );
          setError(PREV_SESSION_TIMEOUT_ERROR);
          return;
        }
        if (recognitionSettledRef.current === prevSignal) {
          recognitionSettledRef.current = null;
        }
        if (announced) setRecDiag(null);
      }
      if (takeStateRef.current !== "starting") {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }
      recognitionErrorRef.current = null;
      recognitionFatalRef.current = false;
      recognitionRestartsRef.current = 0;
      earlyFailuresRef.current = 0;
      recognitionStartErrorRef.current = null;
      sessionCountRef.current = 0;
      anyResultRef.current = false;
      recognitionSettledRef.current = createSettledSignal();
      recognitionActiveRef.current = true;
      if (!beginRecognition(Ctor, takeId)) {
        // Recognition could not start at all: do not begin a take the
        // user believes is being transcribed. Release the mic and say
        // so instead of silently recording without recognition.
        recognitionActiveRef.current = false;
        recognitionSettledRef.current = null;
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        takeStateRef.current = "none";
        setPhase("idle");
        setRecDiag(
          recognitionStartFailedDiag(recognitionStartErrorRef.current ?? "start failed"),
        );
        setError(RECOGNITION_START_FAILED_ERROR);
        return;
      }
    }

    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = handleRecorderStop;
    recorderRef.current = recorder;
    startMicMonitor(stream);
    recorder.start();
    takeStartedAtRef.current = Date.now();

    takeStateRef.current = "recording";
    setElapsed(0);
    setPhase("recording");
    timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
  }

  function stopRecording() {
    if (takeStateRef.current !== "recording") return;
    takeStateRef.current = "stopping";
    setPhase("stopping");
    stopElapsedTimer();
    // Ask recognition to stop, and make sure a pending mid-take
    // restart cannot fire after this point.
    recognitionActiveRef.current = false;
    clearRestartTimer();
    try {
      recognitionRef.current?.stop();
    } catch {
      // already ended
    }
    if (!recognitionRef.current) {
      // No live session (it already ended, or died fatally): nothing
      // will fire `onend`, so release the scoring path's wait now.
      recognitionSettledRef.current?.resolve();
    }
    const recorder = recorderRef.current;
    if (!recorder) {
      void handleRecorderStop();
      return;
    }
    try {
      recorder.stop();
    } catch {
      // Already inactive: `onstop` will not fire, so finish here.
      void handleRecorderStop();
    }
  }

  /** Cancel a take in progress: stops the mic and recognizer and discards
   *  the recording without scoring it. Also works while scoring is in
   *  flight — the mutation's callbacks then drop the attempt — and in
   *  the brief window after 停止 was pressed, while the stop is still
   *  settling: the stop path re-checks the cancel flag after its wait
   *  and discards the take instead of scoring it. */
  function cancelAttempt() {
    if (phase !== "recording" && phase !== "stopping" && phase !== "scoring") return;
    cancelledRef.current = true;
    if (phase === "scoring") {
      // The recorder already stopped; the scoring callbacks discard the
      // attempt when the request settles.
      setInfoMsg("キャンセルしています…");
      return;
    }
    stopElapsedTimer();
    recognitionActiveRef.current = false;
    clearRestartTimer();
    const rec = recognitionRef.current;
    try {
      if (rec?.abort) rec.abort();
      else rec?.stop();
    } catch {
      // already ended
    }
    if (!recognitionRef.current) {
      recognitionSettledRef.current?.resolve();
    }
    if (takeStateRef.current === "stopping") {
      // handleRecorderStop is already in flight (the user pressed 停止
      // first); it re-checks cancelledRef after its recognition wait
      // and discards the take, so there is nothing more to stop here.
      setInfoMsg("キャンセルしています…");
      return;
    }
    takeStateRef.current = "stopping";
    const recorder = recorderRef.current;
    if (!recorder) {
      discardCancelledTake();
      return;
    }
    try {
      recorder.stop();
    } catch {
      // Already inactive: nothing will fire onstop, so clean up here.
      discardCancelledTake();
    }
  }

  async function handleRecorderStop() {
    if (stopHandledRef.current) return;
    stopHandledRef.current = true;
    stopMicMonitor();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    let settleTimedOut = false;
    if (!cancelledRef.current && recognitionSettledRef.current) {
      // The recognizer delivers its final results asynchronously, just
      // before `onend`; this recorder callback can fire first. Wait
      // for recognition to settle (bounded) so the last words are in
      // finalHeardRef before scoring — otherwise a take could be
      // scored from an empty or truncated transcript.
      const signal = recognitionSettledRef.current;
      let settled = false;
      await Promise.race([
        signal.promise.then(() => {
          settled = true;
        }),
        new Promise<void>((r) => window.setTimeout(r, 3000)),
      ]);
      if (settled) {
        // This take's signal has done its job and can be dropped. On
        // timeout it is KEPT instead: the session may still be
        // shutting down, and the next take must wait for its real end
        // before starting (the same rule the cancel path follows).
        if (recognitionSettledRef.current === signal) {
          recognitionSettledRef.current = null;
        }
      } else {
        settleTimedOut = true;
        setRecDiag(settleTimeoutDiag(3));
      }
    }
    const mimeType = recorderRef.current?.mimeType || "audio/webm";
    recognitionRef.current = null;
    recorderRef.current = null;
    if (cancelledRef.current) {
      // Cancelled — including a cancel pressed during the wait above:
      // throw the audio and transcript away, no scoring, no history.
      discardCancelledTake();
      return;
    }
    takeStateRef.current = "none";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    recordingBlobRef.current = blob.size > 0 ? blob : null;
    if (blob.size > 0) setRecordingUrl(URL.createObjectURL(blob));

    const heard = finalHeardRef.current.trim();
    if (!recognitionSupported) {
      setPhase("recordedOnly");
      return;
    }
    if (!heard) {
      setEmptyRecognition(true);
      // An empty take must ALWAYS leave its facts on screen, even
      // when the recognizer ended silently with no error code at
      // all — that silent case is exactly the one that used to show
      // only the generic message, leaving nothing to report. The
      // summary states what the take actually did: how long it ran,
      // how many recognition sessions started, whether any of them
      // ever produced a result, which error code (if any) the
      // browser reported, and the peak mic input level measured
      // during the take. The peak is what separates the two
      // remaining suspects: a healthy peak means the voice reached
      // the microphone and the browser's recognizer returned
      // nothing; a near-zero peak means the voice never arrived.
      const takeSecs =
        takeStartedAtRef.current !== null
          ? Math.max(0, Math.round((Date.now() - takeStartedAtRef.current) / 1000))
          : null;
      const micPeak = micPeakRef.current;
      // The values above are all this hook computes. The wording of
      // the summary, of its plain-language reading, and of the error
      // message below is assembled in lib/messages.ts from the
      // take's facts and error code.
      const summary = emptyRecognitionSummary({
        takeSecs,
        sessionCount: sessionCountRef.current,
        restarts: recognitionRestartsRef.current,
        earlyFailures: earlyFailuresRef.current,
        anyResult: anyResultRef.current,
        finalSegmentCount: finalSegmentsRef.current.length,
        micPeak,
        errorCode: recognitionErrorRef.current,
        settleTimedOut,
      });
      setRecDiag(summary);
      // The note is shown inside the error frame together with the
      // summary so the whole report is in one place.
      const note = emptyRecognitionNote(micPeak);
      setEmptyDiag({ summary, note });
      // Persist the failure so it survives the reload the reset
      // button performs, and can be reported verbatim afterwards.
      onFailureRef.current(summary);
      setError(emptyRecognitionError(recognitionErrorRef.current));
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

  const busy =
    phase === "recording" || phase === "scoring" || phase === "starting" || phase === "stopping";

  return {
    phase,
    result,
    setResult,
    liveHeard,
    recordingUrl,
    recordingBlobRef,
    error,
    setError,
    recDiag,
    emptyRecognition,
    emptyDiag,
    micLevel,
    infoMsg,
    setInfoMsg,
    elapsed,
    recognitionSupported,
    busy,
    resetAttemptState,
    playModel,
    startRecording,
    stopRecording,
    cancelAttempt,
  };
}

// Re-exported so the failure-log append in App can cap the list the
// same way the hook's summary producer expects.
export { FAILURE_LOG_LIMIT };
