// 英語発音チェック — App composition.
//
// The client is split by concern (see DATA-PLAN.md):
//   lib/storage.ts        localStorage stores (destinations, texts, failure log)
//   lib/speech.ts         Web Speech typings, constants, candidate builder
//   lib/sound-changes.ts  sound-change candidate detection (pure)
//   lib/audio.ts          blob → base64
//   hooks/useRecordingSession.ts   recording + recognition lifecycle (one file, whole)
//   hooks/usePracticeTexts.ts      practice text draft + saved-texts list
//   hooks/useNotionDestinations.ts Notion destinations + save actions
//   components/           candidate display, saved texts, failure log,
//                         result + Notion form, history
// This file only wires them together and renders the practice panel
// shell (text input, record controls, status lines).

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api } from "./api";
import { FailureLogPanel } from "./components/FailureLogPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { ResultPanel } from "./components/ResultPanel";
import { SavedTextsPanel } from "./components/SavedTextsPanel";
import { SoundChangeCandidates } from "./components/SoundChangeCandidates";
import { useNotionDestinations } from "./hooks/useNotionDestinations";
import { usePracticeTexts } from "./hooks/usePracticeTexts";
import { useRecordingSession } from "./hooks/useRecordingSession";
import { findCandidates, parseTokens } from "./lib/sound-changes";
import {
  loadStoredFailureLog,
  loadStoredPracticeText,
  storeFailureLog,
  FAILURE_LOG_LIMIT,
  type FailureLogEntry,
} from "./lib/storage";
import { SERIF } from "./lib/ui";

const FIELDS = actionFields<typeof Actions>();

export function App() {
  const queryClient = useQueryClient();
  const [customText, setCustomText] = useState<string>(loadStoredPracticeText);
  const [failureLog, setFailureLog] = useState<FailureLogEntry[]>(loadStoredFailureLog);
  const [failureLogOpen, setFailureLogOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const target = customText.trim();

  // The recording session's reset also clears the Notion export UI
  // state (as the old single resetAttemptState did); the notion hook
  // is created after the session hook, so the reset is forwarded
  // through a ref that is filled in below.
  const notionResetRef = useRef<() => void>(() => undefined);

  const session = useRecordingSession({
    target,
    onRecognitionFailure: (summary) => {
      // Persist the failure so it survives the reload the reset
      // button performs, and can be reported verbatim afterwards.
      setFailureLog((prev) =>
        [{ at: new Date().toISOString(), summary }, ...prev].slice(0, FAILURE_LOG_LIMIT),
      );
    },
    onReset: () => notionResetRef.current(),
  });
  const {
    phase,
    result,
    liveHeard,
    recordingUrl,
    error,
    recDiag,
    emptyRecognition,
    emptyDiag,
    micLevel,
    infoMsg,
    elapsed,
    recognitionSupported,
    busy,
  } = session;

  const notion = useNotionDestinations({
    result,
    setResult: session.setResult,
    recordingBlobRef: session.recordingBlobRef,
  });
  notionResetRef.current = notion.resetNotionState;

  const texts = usePracticeTexts(customText, setCustomText, {
    busy,
    resetAttemptState: session.resetAttemptState,
    setInfoMsg: session.setInfoMsg,
    setError: session.setError,
  });

  useEffect(() => {
    storeFailureLog(failureLog);
  }, [failureLog]);

  const tokens = useMemo(() => parseTokens(customText), [customText]);
  const candidates = useMemo(() => findCandidates(tokens), [tokens]);

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

  function reuseAttempt(text: string) {
    if (busy) return;
    setCustomText(text);
    session.resetAttemptState();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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
              session.resetAttemptState();
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
              onClick={texts.saveCurrentText}
              disabled={busy || !target || texts.isCurrentTextSaved}
              className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              aria-label="入力した英文を保存する"
            >
              {texts.isCurrentTextSaved ? "保存済み" : "この英文を保存"}
            </button>
            <button
              type="button"
              onClick={texts.clearPracticeText}
              disabled={busy || !customText}
              className="rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-40"
              aria-label="入力した英文をクリアする"
            >
              クリア
            </button>
            <span className="text-xs text-[var(--dim)]">保存先はこの端末のブラウザです</span>
          </div>

          <SavedTextsPanel
            savedTexts={texts.savedTexts}
            open={texts.savedTextsOpen}
            onToggle={() => texts.setSavedTextsOpen((v) => !v)}
            confirmClearSaved={texts.confirmClearSaved}
            onAskClearAll={() => texts.setConfirmClearSaved(true)}
            onCancelClearAll={() => texts.setConfirmClearSaved(false)}
            onClearAll={texts.clearAllSavedTexts}
            target={target}
            busy={busy}
            onLoad={texts.loadSavedText}
            onDelete={texts.deleteSavedText}
          />

          {target && (
            <SoundChangeCandidates text={customText} tokens={tokens} candidates={candidates} />
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={session.playModel}
              disabled={busy}
              className="rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-40"
              aria-label="入力した英文を読み上げて再生"
            >
              ▶ お手本を聞く
            </button>
            {phase === "recording" ? (
              <>
                <button
                  type="button"
                  onClick={session.stopRecording}
                  className="rounded-full bg-[var(--record)] px-6 py-3 text-base font-semibold text-white"
                  aria-label="録音を停止して採点"
                >
                  ■ 停止して採点（{elapsed}秒）
                </button>
                <button
                  type="button"
                  onClick={session.cancelAttempt}
                  className="rounded-full border border-[var(--border)] px-5 py-3 text-base font-medium text-[var(--dim)]"
                  aria-label="録音をキャンセルして採点を中止"
                >
                  ✕ キャンセル
                </button>
              </>
            ) : phase === "stopping" ? (
              <>
                <button
                  type="button"
                  disabled
                  className="rounded-full bg-[var(--record)] px-6 py-3 text-base font-semibold text-white opacity-40"
                  aria-label="録音を停止しています"
                >
                  ■ 停止中…
                </button>
                <button
                  type="button"
                  onClick={session.cancelAttempt}
                  className="rounded-full border border-[var(--border)] px-5 py-3 text-base font-medium text-[var(--dim)]"
                  aria-label="録音をキャンセルして採点を中止"
                >
                  ✕ キャンセル
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void session.startRecording()}
                disabled={phase === "scoring" || phase === "starting"}
                className="rounded-full bg-[var(--record)] px-6 py-3 text-base font-semibold text-white disabled:opacity-40"
                aria-label="録音を開始"
              >
                {phase === "starting" ? "開始中…" : "● 録音する"}
              </button>
            )}
          </div>

          {phase === "recording" && (
            <div className="mt-4 rounded-[var(--radius)] bg-[var(--bg)] px-3 py-2">
              <p className="flex items-center gap-2 text-sm font-medium text-[var(--record)]">
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--record)]" />
                録音中… 文を読んでください
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="shrink-0 text-xs text-[var(--dim)]">マイク音量</span>
                <div
                  className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]"
                  role="meter"
                  aria-label="マイク入力音量"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(micLevel * 100)}
                >
                  <div
                    className="h-full rounded-full bg-[var(--accent)]"
                    style={{ width: `${Math.round(micLevel * 100)}%`, transition: "width 0.15s linear" }}
                  />
                </div>
              </div>
              {liveHeard && (
                <p className="mt-1 text-sm text-[var(--dim)]" style={{ fontFamily: SERIF }}>
                  {liveHeard}
                </p>
              )}
            </div>
          )}

          {phase === "stopping" && (
            <p className="mt-4 text-sm text-[var(--dim)]">停止しています…</p>
          )}

          {phase === "scoring" && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-[var(--dim)]">採点中…</p>
              <button
                type="button"
                onClick={session.cancelAttempt}
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
            <div className="mt-4 rounded-[var(--radius)] bg-[var(--record-soft)] px-3 py-2">
              <p role="alert" className="text-sm leading-relaxed text-[var(--ng-text)]">
                {error}
              </p>
              {emptyRecognition && emptyDiag && (
                <div className="mt-2 text-sm leading-relaxed text-[var(--ng-text)]">
                  <p>音声認識の状態: {emptyDiag.summary}</p>
                  {emptyDiag.note && <p className="mt-1">{emptyDiag.note}</p>}
                </div>
              )}
              {emptyRecognition && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="rounded-full border border-[var(--ng-text)] px-4 py-1.5 text-sm font-medium text-[var(--ng-text)]"
                    aria-label="ページを再読み込みして音声認識をリセット"
                  >
                    認識をリセット（再読み込み）
                  </button>
                  <span className="text-xs leading-relaxed text-[var(--ng-text)]">
                    再読み込みしても、入力中の英文・保存済みの英文・練習履歴は消えません。
                  </span>
                </div>
              )}
            </div>
          )}

          {recDiag && (
            <p
              role="status"
              className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm leading-relaxed text-[var(--dim)]"
            >
              音声認識の状態: {recDiag}
            </p>
          )}

          <FailureLogPanel
            failureLog={failureLog}
            open={failureLogOpen}
            onToggle={() => setFailureLogOpen((v) => !v)}
            onClear={() => setFailureLog([])}
          />

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

          {phase === "done" && result && <ResultPanel result={result} notion={notion} />}
        </section>

        {/* History */}
        <HistoryPanel
          attempts={attempts}
          isPending={attemptsQuery.isPending}
          confirmClear={confirmClear}
          onAskClear={() => setConfirmClear(true)}
          onCancelClear={() => setConfirmClear(false)}
          onClearAll={() => clearMutation.mutate()}
          historyNotionMsg={notion.historyNotionMsg}
          saveNotionPending={notion.saveNotionMutation.isPending}
          saveNotionVariables={notion.saveNotionMutation.variables}
          onSaveToNotion={notion.saveHistoryToNotion}
          onReuse={reuseAttempt}
          onDelete={(id) => deleteMutation.mutate(id)}
        />

        <p className="mt-8 text-xs leading-relaxed text-[var(--dim)]">
          録音した音声は端末の中だけで再生され、通常はサーバーに送られません。結果画面で「Notionに保存」を選んだ場合に限り、その回の結果と音声がNotionへ送信されます。履歴には入力した英文・認識された文・スコアだけが保存されます。
        </p>
      </main>
    </div>
  );
}
