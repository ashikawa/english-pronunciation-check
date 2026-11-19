// SavedTextsPanel — the collapsible 保存済みの英文 list. State and
// handlers live in hooks/usePracticeTexts.ts; this is rendering only.

import { SAVED_TEXTS_LIMIT } from "../lib/storage";
import { SERIF } from "../lib/ui";

export function SavedTextsPanel({
  savedTexts,
  open,
  onToggle,
  confirmClearSaved,
  onAskClearAll,
  onCancelClearAll,
  onClearAll,
  target,
  busy,
  onLoad,
  onDelete,
}: {
  savedTexts: string[];
  open: boolean;
  onToggle: () => void;
  confirmClearSaved: boolean;
  onAskClearAll: () => void;
  onCancelClearAll: () => void;
  onClearAll: () => void;
  target: string;
  busy: boolean;
  onLoad: (text: string) => void;
  onDelete: (text: string) => void;
}) {
  if (savedTexts.length === 0) return null;
  return (
    <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="saved-texts-body"
          aria-label={open ? "保存済みの英文を折り畳む" : "保存済みの英文を表示する"}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span
            aria-hidden="true"
            className="shrink-0 text-xs text-[var(--dim)]"
            style={{
              display: "inline-block",
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          >
            ▶
          </span>
          <h3 className="text-sm font-semibold">
            保存済みの英文
            <span className="ml-1.5 font-normal text-[var(--dim)]">（{savedTexts.length}件）</span>
          </h3>
        </button>
        {open &&
          (confirmClearSaved ? (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClearAll}
                className="rounded-full bg-[var(--record)] px-3 py-1.5 text-xs font-semibold text-white"
                aria-label="保存済みの英文をすべて削除する（確認）"
              >
                本当に全件削除
              </button>
              <button
                type="button"
                onClick={onCancelClearAll}
                className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs"
                aria-label="保存済みの英文の全件削除をキャンセル"
              >
                キャンセル
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onAskClearAll}
              className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)]"
              aria-label="保存済みの英文をすべて削除"
            >
              すべて削除
            </button>
          ))}
      </div>
      {open && (
        <div id="saved-texts-body">
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
                  onClick={() => onLoad(text)}
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
                  onClick={() => onDelete(text)}
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
    </div>
  );
}
