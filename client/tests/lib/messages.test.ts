// Unit tests for lib/messages.ts — the recognition error / diagnostic
// wording extracted from hooks/useRecordingSession.ts.
//
// The session hook now hands this module a code + values and renders
// whatever comes back, so these tests pin the EXACT strings the user
// sees (and reports verbatim from the failure log). If a wording
// change is intended, update the expectation here in the same change;
// an accidental rewording must fail loudly.

import { describe, expect, test } from "bun:test";
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
  type EmptyRecognitionFacts,
} from "../../src/lib/messages";

const baseFacts: EmptyRecognitionFacts = {
  takeSecs: 30,
  sessionCount: 1,
  restarts: 0,
  earlyFailures: 0,
  anyResult: false,
  finalSegmentCount: 0,
  micPeak: 0.42,
  errorCode: null,
  settleTimedOut: false,
};

describe("diagnostic line templates", () => {
  test("live recognition error carries the browser's code", () => {
    expect(recognitionErrorDiag("network")).toBe("音声認識エラー: network");
    expect(recognitionErrorDiag("not-allowed")).toBe("音声認識エラー: not-allowed");
  });

  test("early-end give-up names the code and the stop", () => {
    expect(earlyEndGiveUpDiag("early-end")).toBe(
      "音声認識が開始直後に終了する状態が続いています（エラー: early-end）。これ以上は自動で再試行しません。",
    );
  });

  test("restart failure names the start failure detail", () => {
    expect(restartFailedDiag("InvalidStateError: already started")).toBe(
      "音声認識を再開できませんでした（InvalidStateError: already started）。",
    );
    expect(restartFailedDiag("start failed")).toBe(
      "音声認識を再開できませんでした（start failed）。",
    );
  });

  test("restart limit names the budget and the code", () => {
    expect(restartLimitDiag(30, "restart-limit")).toBe(
      "音声認識セッションの再開が上限（30回）に達したため、再開を停止しました（エラー: restart-limit）。録音は続いていますが、この回はここまでしか認識されません。",
    );
  });

  test("previous-session wait messages", () => {
    expect(prevSessionWaitingDiag()).toBe(
      "前の音声認識セッションの終了を待っています…（終了するまで録音を開始しません）",
    );
    expect(prevSessionTimeoutDiag(20)).toBe(
      "前の音声認識セッションが20秒待っても終了しませんでした（終了待ちタイムアウト）。",
    );
    expect(PREV_SESSION_TIMEOUT_ERROR).toBe(
      "前の音声認識セッションの終了待ちがタイムアウトしました。少し待ってから、もう一度録音してください。",
    );
  });

  test("recognition start failure messages", () => {
    expect(recognitionStartFailedDiag("NotSupportedError: nope")).toBe(
      "音声認識の開始に失敗しました（NotSupportedError: nope）。",
    );
    expect(RECOGNITION_START_FAILED_ERROR).toBe(
      "音声認識を開始できませんでした。少し待ってから、もう一度録音してください。",
    );
  });

  test("settle timeout names the bound in seconds", () => {
    expect(settleTimeoutDiag(3)).toBe(
      "音声認識の終了待ちがタイムアウトしました（3秒）。最後の単語が認識結果に反映されていない可能性があります。",
    );
  });
});

describe("emptyRecognitionSummary", () => {
  test("the reported v16-style silent failure renders verbatim", () => {
    // The shape of the failure the user actually reported: one
    // healthy session, ~30 s, no results, no error code.
    expect(emptyRecognitionSummary(baseFacts)).toBe(
      "認識結果が空でした（録音時間: 約30秒 / 認識セッション開始: 1回 / 再起動: 0回 / 開始直後の終了: 0回 / 結果イベント: なし / 確定した文: 0件 / マイク音量ピーク: 約42% / エラーコード: なし）",
    );
  });

  test("unknown duration, unmeasured peak, error code, settle timeout", () => {
    expect(
      emptyRecognitionSummary({
        takeSecs: null,
        sessionCount: 4,
        restarts: 2,
        earlyFailures: 1,
        anyResult: true,
        finalSegmentCount: 3,
        micPeak: null,
        errorCode: "network",
        settleTimedOut: true,
      }),
    ).toBe(
      "認識結果が空でした（録音時間: 不明 / 認識セッション開始: 4回 / 再起動: 2回 / 開始直後の終了: 1回 / 結果イベント: あり / 確定した文: 3件 / マイク音量ピーク: 計測できず / エラーコード: network / 終了待ち: タイムアウト（3秒））",
    );
  });

  test("peak percentage is rounded", () => {
    expect(emptyRecognitionSummary({ ...baseFacts, micPeak: 0.426 })).toContain(
      "マイク音量ピーク: 約43%",
    );
    expect(emptyRecognitionSummary({ ...baseFacts, micPeak: 0 })).toContain(
      "マイク音量ピーク: 約0%",
    );
  });
});

describe("emptyRecognitionNote", () => {
  test("unmeasured peak says nothing instead of guessing", () => {
    expect(emptyRecognitionNote(null)).toBeNull();
  });

  test("near-zero peak points at the microphone side", () => {
    expect(emptyRecognitionNote(0)).toBe(
      "マイク音量ピークがほぼゼロでした。声がマイクに届いていなかった可能性があります（マイクの接続・選択・ミュートを確認してください）。",
    );
    expect(emptyRecognitionNote(0.029)).toContain("マイク音量ピークがほぼゼロでした");
  });

  test("healthy peak points at the recognizer side; 0.03 is the boundary", () => {
    expect(emptyRecognitionNote(0.03)).toBe(
      "マイクには声が届いていました。ブラウザ側の音声認識サービスが結果を返さなかった可能性が高いです。「認識をリセット（再読み込み）」を試してください。",
    );
    expect(emptyRecognitionNote(0.9)).toContain("マイクには声が届いていました");
  });
});

describe("emptyRecognitionError", () => {
  test("permission codes", () => {
    const msg =
      "音声認識の使用が許可されませんでした。ブラウザの設定で音声認識（マイク）の許可を確認してください。";
    expect(emptyRecognitionError("not-allowed")).toBe(msg);
    expect(emptyRecognitionError("service-not-allowed")).toBe(msg);
  });

  test("audio-capture", () => {
    expect(emptyRecognitionError("audio-capture")).toBe(
      "マイクから音声を取得できませんでした。マイクの接続を確認してもう一度お試しください。",
    );
  });

  test("early-end", () => {
    expect(emptyRecognitionError("early-end")).toBe(
      "音声認識が開始直後に終了してしまい、認識できませんでした。ネットワーク接続を確認してもう一度お試しください。",
    );
  });

  test("network", () => {
    expect(emptyRecognitionError("network")).toBe(
      "音声認識の通信に失敗しました。ネットワーク接続を確認してもう一度お試しください。",
    );
  });

  test("null and unlisted codes fall back to the generic message", () => {
    const generic =
      "音声が認識できませんでした。静かな場所で、もう少し大きな声で読んでみてください。";
    expect(emptyRecognitionError(null)).toBe(generic);
    expect(emptyRecognitionError("restart-limit")).toBe(generic);
    expect(emptyRecognitionError("aborted")).toBe(generic);
  });
});
