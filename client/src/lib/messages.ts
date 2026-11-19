// messages — wording for the recognition errors and diagnostics.
//
// The recording session (hooks/useRecordingSession.ts) owns the
// recognition lifecycle: codes, counts, timings, peaks. It does NOT
// own the Japanese wording shown on screen. Every fixed sentence the
// session puts into the 「音声認識の状態」 line, the empty-take error
// frame, or the failure log is assembled here from the code + values
// the session hands over, so the wording lives in exactly one place:
// rewording never touches the session logic, and tests can pin the
// session's behavior by code and value instead of by full sentences.
//
// Scope (per AGENTS.md「メッセージとロジックの分離」): only the fixed
// recognition wording that used to be embedded in the session logic.
// NOT here: the model-generated feedback text (generated content),
// labels inside display components, and the Notion export body.

/** Facts of a take that ended with an empty transcript. The session
 *  measures these; this module only formats them. */
export interface EmptyRecognitionFacts {
  /** Recording length in seconds, or null when the start time is
   *  unknown. */
  takeSecs: number | null;
  /** How many recognition sessions were started during the take. */
  sessionCount: number;
  /** Mid-take restarts used (the budget resets on any result). */
  restarts: number;
  /** Sessions that ended immediately after starting, resultless. */
  earlyFailures: number;
  /** Whether any result event ever arrived during the take. */
  anyResult: boolean;
  /** Finalized segment count. */
  finalSegmentCount: number;
  /** Peak mic input level (0..1) measured on the recorder's stream,
   *  or null when it could not be measured. */
  micPeak: number | null;
  /** The browser's last recognition error code, or null. */
  errorCode: string | null;
  /** Whether the stop path's recognition settle wait timed out. */
  settleTimedOut: boolean;
}

/** A live recognition error, shown as it happens with the browser's
 *  own error code so it can be reported as-is. */
export function recognitionErrorDiag(errorCode: string): string {
  return `音声認識エラー: ${errorCode}`;
}

/** Sessions keep dying immediately after starting; the take stops
 *  retrying and says so, with the error code. */
export function earlyEndGiveUpDiag(errorCode: string): string {
  return `音声認識が開始直後に終了する状態が続いています（エラー: ${errorCode}）。これ以上は自動で再試行しません。`;
}

/** A mid-take restart (or a failed-start retry) could not start a new
 *  session; `detail` names the start failure. */
export function restartFailedDiag(detail: string): string {
  return `音声認識を再開できませんでした（${detail}）。`;
}

/** The mid-take restart budget is spent; recognition stops for the
 *  rest of the take and the reason stays on screen. */
export function restartLimitDiag(maxRestarts: number, errorCode: string): string {
  return `音声認識セッションの再開が上限（${maxRestarts}回）に達したため、再開を停止しました（エラー: ${errorCode}）。録音は続いていますが、この回はここまでしか認識されません。`;
}

/** The next take is waiting for the previous session to actually end
 *  before starting (starting over a still-ending session throws). */
export function prevSessionWaitingDiag(): string {
  return "前の音声認識セッションの終了を待っています…（終了するまで録音を開始しません）";
}

/** The previous session did not end within the hard cap; the new take
 *  is aborted instead of starting over it. Diagnostic line form. */
export function prevSessionTimeoutDiag(capSecs: number): string {
  return `前の音声認識セッションが${capSecs}秒待っても終了しませんでした（終了待ちタイムアウト）。`;
}

/** Error-frame form of the previous-session wait timeout. */
export const PREV_SESSION_TIMEOUT_ERROR =
  "前の音声認識セッションの終了待ちがタイムアウトしました。少し待ってから、もう一度録音してください。";

/** Recognition could not be started at all for a new take;
 *  `detail` names the start failure. Diagnostic line form. */
export function recognitionStartFailedDiag(detail: string): string {
  return `音声認識の開始に失敗しました（${detail}）。`;
}

/** Error-frame form of a recognition start failure. */
export const RECOGNITION_START_FAILED_ERROR =
  "音声認識を開始できませんでした。少し待ってから、もう一度録音してください。";

/** The stop path's recognition settle wait timed out; the last words
 *  may be missing from the transcript. */
export function settleTimeoutDiag(timeoutSecs: number): string {
  return `音声認識の終了待ちがタイムアウトしました（${timeoutSecs}秒）。最後の単語が認識結果に反映されていない可能性があります。`;
}

/** The empty take's diagnostic summary: the one line that is rendered
 *  in the 「音声認識の状態」 line, inside the error frame, AND stored
 *  in the persistent failure log — all three read this same string. */
export function emptyRecognitionSummary(facts: EmptyRecognitionFacts): string {
  const takePart = facts.takeSecs !== null ? `約${facts.takeSecs}秒` : "不明";
  const peakPart =
    facts.micPeak !== null ? `約${Math.round(facts.micPeak * 100)}%` : "計測できず";
  const timeoutPart = facts.settleTimedOut ? " / 終了待ち: タイムアウト（3秒）" : "";
  return `認識結果が空でした（録音時間: ${takePart} / 認識セッション開始: ${facts.sessionCount}回 / 再起動: ${facts.restarts}回 / 開始直後の終了: ${facts.earlyFailures}回 / 結果イベント: ${facts.anyResult ? "あり" : "なし"} / 確定した文: ${facts.finalSegmentCount}件 / マイク音量ピーク: ${peakPart} / エラーコード: ${facts.errorCode ?? "なし"}${timeoutPart}）`;
}

/** A plain-language reading of the empty take's mic peak, shown
 *  inside the error frame together with the summary. Worded as a
 *  possibility, not a verdict: the peak is measured on the recorder's
 *  stream, which is strong but not absolute evidence about the
 *  recognizer's own input. Null when the peak could not be measured —
 *  then nothing is guessed. */
export function emptyRecognitionNote(micPeak: number | null): string | null {
  if (micPeak === null) return null;
  return micPeak < 0.03
    ? "マイク音量ピークがほぼゼロでした。声がマイクに届いていなかった可能性があります（マイクの接続・選択・ミュートを確認してください）。"
    : "マイクには声が届いていました。ブラウザ側の音声認識サービスが結果を返さなかった可能性が高いです。「認識をリセット（再読み込み）」を試してください。";
}

/** The empty take's error-frame message, chosen by the browser's
 *  error code (null / unlisted codes fall back to the generic
 *  message). */
export function emptyRecognitionError(errorCode: string | null): string {
  if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
    return "音声認識の使用が許可されませんでした。ブラウザの設定で音声認識（マイク）の許可を確認してください。";
  }
  if (errorCode === "audio-capture") {
    return "マイクから音声を取得できませんでした。マイクの接続を確認してもう一度お試しください。";
  }
  if (errorCode === "early-end") {
    return "音声認識が開始直後に終了してしまい、認識できませんでした。ネットワーク接続を確認してもう一度お試しください。";
  }
  if (errorCode === "network") {
    return "音声認識の通信に失敗しました。ネットワーク接続を確認してもう一度お試しください。";
  }
  return "音声が認識できませんでした。静かな場所で、もう少し大きな声で読んでみてください。";
}
