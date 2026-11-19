// ResultPanel — the scored result (score, per-word chips, recognized
// sentence, feedback) plus the opt-in Notion export form. Notion
// state and actions live in hooks/useNotionDestinations.ts; this is
// rendering only.

import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../../server/src/actions";
import type { Attempt } from "../hooks/useRecordingSession";
import type { useNotionDestinations } from "../hooks/useNotionDestinations";
import { SERIF } from "../lib/ui";

const FIELDS = actionFields<typeof Actions>();

type NotionApi = ReturnType<typeof useNotionDestinations>;

export function ResultPanel({ result, notion }: { result: Attempt; notion: NotionApi }) {
  const {
    wantNotion,
    setWantNotion,
    destinations,
    destQuery,
    setDestQuery,
    destQueryError,
    setDestQueryError,
    notionMsg,
    effectiveDestId,
    setSelectedDest,
    setDefaultDestination,
    searchDestMutation,
    saveNotionMutation,
    saveResultToNotion,
  } = notion;

  return (
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
  );
}
