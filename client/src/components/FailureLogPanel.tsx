// FailureLogPanel — the collapsible 音声認識の失敗ログ list. The log
// itself lives in localStorage (lib/storage.ts) and its state in
// App; this is rendering only.

import { FAILURE_LOG_LIMIT, type FailureLogEntry } from "../lib/storage";

export function FailureLogPanel({
  failureLog,
  open,
  onToggle,
  onClear,
}: {
  failureLog: FailureLogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}) {
  if (failureLog.length === 0) return null;
  return (
    <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="failure-log-body"
          aria-label={open ? "音声認識の失敗ログを折り畳む" : "音声認識の失敗ログを表示する"}
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
            音声認識の失敗ログ
            <span className="ml-1.5 font-normal text-[var(--dim)]">（{failureLog.length}件）</span>
          </h3>
        </button>
        {open && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)]"
            aria-label="音声認識の失敗ログを消去"
          >
            ログを消去
          </button>
        )}
      </div>
      {open && (
        <div id="failure-log-body">
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            認識結果が空で終わった回の診断です。再読み込みしても消えません。失敗したときは、この文言をそのまま報告してください。保存はこの端末のみで、最大{FAILURE_LOG_LIMIT}件です。
          </p>
          <ul className="mt-2 space-y-2">
            {failureLog.map((entry, idx) => (
              <li
                key={`${entry.at}-${idx}`}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm leading-relaxed"
              >
                <span className="block text-xs text-[var(--dim)]">
                  {new Date(entry.at).toLocaleString("ja-JP", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                {entry.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
