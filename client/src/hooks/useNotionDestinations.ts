// useNotionDestinations — the Notion export state and actions.
//
// The destination list lives in localStorage (see lib/storage.ts);
// every change is written back so the picker survives reloads on this
// device. Searching proxies through the server but stores nothing
// there. Saving sends the recording ONLY in the explicit save request
// the user triggers; history saves go without audio because
// recordings are not retained.

import { useEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { blobToBase64 } from "../lib/audio";
import {
  loadStoredDestinations,
  storeDestinations,
  type Destination,
} from "../lib/storage";
import type { Attempt } from "./useRecordingSession";

export function useNotionDestinations(deps: {
  result: Attempt | null;
  setResult: (attempt: Attempt) => void;
  recordingBlobRef: RefObject<Blob | null>;
}) {
  const queryClient = useQueryClient();
  const { result, setResult, recordingBlobRef } = deps;
  const resultRef = useRef(result);
  resultRef.current = result;

  const [wantNotion, setWantNotion] = useState(false);
  const [destinations, setDestinations] = useState<Destination[]>(loadStoredDestinations);
  const [selectedDest, setSelectedDest] = useState("");
  const [destQuery, setDestQuery] = useState("");
  const [destQueryError, setDestQueryError] = useState<string | null>(null);
  const [notionMsg, setNotionMsg] = useState<string | null>(null);
  const [historyNotionMsg, setHistoryNotionMsg] = useState<string | null>(null);

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
  };

  const saveNotionMutation = useMutation({
    mutationFn: async (v: NotionSaveVars) => await api.saveToNotion(v),
    onSuccess: (data, vars) => {
      const current = resultRef.current;
      const isCurrent = current !== null && vars.attemptId === current.id;
      if (data.status === "error") {
        if (isCurrent) setNotionMsg(data.message ?? "Notionへの保存に失敗しました。");
        else setHistoryNotionMsg(data.message ?? "Notionへの保存に失敗しました。");
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["attempts"] });
      if (isCurrent && data.pageUrl && current) {
        setResult({
          ...current,
          notion_page_url: data.pageUrl,
          notion_parent_title: vars.parentTitle,
        });
      }
      if (!isCurrent) {
        setHistoryNotionMsg("Notionに保存しました（音声なし）。");
      }
    },
    onError: (_e, vars) => {
      const current = resultRef.current;
      const isCurrent = current !== null && vars.attemptId === current.id;
      if (isCurrent) setNotionMsg("Notionへの保存に失敗しました。通信状態を確認してください。");
      else setHistoryNotionMsg("Notionへの保存に失敗しました。通信状態を確認してください。");
    },
  });

  async function saveResultToNotion() {
    const current = resultRef.current;
    if (!current) return;
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
      attemptId: current.id,
      parentPageId: dest ? dest.pageId : null,
      parentTitle: dest ? dest.title : null,
      audioBase64,
      audioMimeType,
    });
  }

  function saveHistoryToNotion(a: Attempt) {
    setHistoryNotionMsg(null);
    const dest = destinations.find((d) => d.isDefault) ?? destinations[0];
    saveNotionMutation.mutate({
      attemptId: a.id,
      parentPageId: dest ? dest.pageId : null,
      parentTitle: dest ? dest.title : null,
      audioBase64: null,
      audioMimeType: null,
    });
  }

  /** The Notion-side half of the App's attempt reset (previously part
   *  of resetAttemptState in App.tsx). */
  function resetNotionState() {
    setWantNotion(false);
    setSelectedDest("");
    setDestQuery("");
    setDestQueryError(null);
    setNotionMsg(null);
  }

  return {
    wantNotion,
    setWantNotion,
    destinations,
    selectedDest,
    setSelectedDest,
    destQuery,
    setDestQuery,
    destQueryError,
    setDestQueryError,
    notionMsg,
    historyNotionMsg,
    effectiveDestId,
    searchDestMutation,
    saveNotionMutation,
    setDefaultDestination,
    saveResultToNotion,
    saveHistoryToNotion,
    resetNotionState,
  };
}
