// HistoryPanel — the 練習履歴 section: list, per-item Notion save /
// reuse / delete, and the clear-all confirmation. Data comes from
// the attempts query in App; mutations are passed in as callbacks.

import type { Attempt } from "../hooks/useRecordingSession";
import { SERIF } from "../lib/ui";

export function HistoryPanel({
  attempts,
  isPending,
  confirmClear,
  onAskClear,
  onCancelClear,
  onClearAll,
  historyNotionMsg,
  saveNotionPending,
  saveNotionVariables,
  onSaveToNotion,
  onReuse,
  onDelete,
}: {
  attempts: Attempt[];
  isPending: boolean;
  confirmClear: boolean;
  onAskClear: () => void;
  onCancelClear: () => void;
  onClearAll: () => void;
  historyNotionMsg: string | null;
  saveNotionPending: boolean;
  saveNotionVariables: { attemptId: number } | undefined;
  onSaveToNotion: (a: Attempt) => void;
  onReuse: (text: string) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <section aria-label="練習履歴" className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">練習履歴</h2>
        {attempts.length > 0 &&
          (confirmClear ? (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClearAll}
                className="rounded-full bg-[var(--record)] px-3 py-1.5 text-xs font-semibold text-white"
                aria-label="履歴をすべて削除する（確認）"
              >
                本当に全件削除
              </button>
              <button
                type="button"
                onClick={onCancelClear}
                className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs"
                aria-label="全件削除をキャンセル"
              >
                キャンセル
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onAskClear}
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

      {isPending ? (
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
                        onClick={() => onSaveToNotion(a)}
                        disabled={saveNotionPending}
                        className="text-xs font-medium text-[var(--accent)] underline disabled:opacity-40"
                        aria-label={`履歴「${a.target}」をNotionに保存（音声なし）`}
                      >
                        {saveNotionPending && saveNotionVariables?.attemptId === a.id
                          ? "Notionに保存中…"
                          : "Notionに保存（音声なし・既定の保存先）"}
                      </button>
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => onReuse(a.target)}
                  className="shrink-0 rounded-full border border-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]"
                  aria-label={`履歴「${a.target}」の英文でもう一度練習`}
                >
                  もう一度
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(a.id)}
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
  );
}
