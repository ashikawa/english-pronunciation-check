// SoundChangeCandidates — the 音の変化の候補 block: kind/count chips
// plus the annotated sentence (liaison ‿, elided plosives struck
// through, flap t's highlighted, weak-form words dotted-underlined).
// Detection lives in lib/sound-changes.ts; this component only
// renders. The per-candidate list was removed from the UI in 2026-11
// (see DATA-PLAN.md); only chips + annotation are shown.

import { useMemo, type ReactNode } from "react";
import {
  KIND_META,
  KIND_ORDER,
  type Candidate,
  type ChangeKind,
  type Tok,
} from "../lib/sound-changes";
import { SERIF } from "../lib/ui";

export function SoundChangeCandidates({
  text,
  tokens,
  candidates,
}: {
  text: string;
  tokens: Tok[];
  candidates: Candidate[];
}) {
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

  function renderAnnotated(): ReactNode {
    const nodes: ReactNode[] = [];
    let cursor = 0;
    tokens.forEach((tok, i) => {
      if (tok.start > cursor) {
        const gap = text.slice(cursor, tok.start);
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
    if (cursor < text.length) {
      nodes.push(<span key="tail">{text.slice(cursor)}</span>);
    }
    return nodes;
  }

  if (candidates.length === 0) {
    return (
      <p className="mt-3 text-sm text-[var(--dim)]">
        この文では、連結・消失・フラップ・弱形の候補は見つかりませんでした。
      </p>
    );
  }

  return (
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
      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
        候補は綴りからの推定です。実際に音が変化したかまでは判定できません。
      </p>
    </div>
  );
}
