// usePracticeTexts — the practice-text draft and the saved-texts list.
//
// Both live in localStorage (see lib/storage.ts): the current input is
// auto-saved on every change and restored on load; the saved list is
// newest-first, de-duplicated, and capped. The hook receives the
// session-facing callbacks (busy check, attempt reset, message
// setters) from the App so its handlers match the previous inline
// behavior exactly.

import { useEffect, useState } from "react";
import {
  loadStoredSavedTexts,
  storePracticeText,
  storeSavedTexts,
  SAVED_TEXTS_LIMIT,
} from "../lib/storage";

export interface PracticeTextsDeps {
  busy: boolean;
  resetAttemptState: () => void;
  setInfoMsg: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function usePracticeTexts(
  customText: string,
  setCustomText: (text: string) => void,
  deps: PracticeTextsDeps,
) {
  const { busy, resetAttemptState, setInfoMsg, setError } = deps;
  const [savedTexts, setSavedTexts] = useState<string[]>(loadStoredSavedTexts);
  const [savedTextsOpen, setSavedTextsOpen] = useState(false);
  const [confirmClearSaved, setConfirmClearSaved] = useState(false);

  // Auto-save the current input so it is restored on the next visit,
  // and persist the saved-texts list the same way.
  useEffect(() => {
    storePracticeText(customText);
  }, [customText]);

  useEffect(() => {
    storeSavedTexts(savedTexts);
  }, [savedTexts]);

  const target = customText.trim();
  const isCurrentTextSaved = target !== "" && savedTexts.includes(target);

  function clearPracticeText() {
    if (busy) return;
    setCustomText("");
    resetAttemptState();
    setInfoMsg("テキストをクリアしました。");
  }

  function saveCurrentText() {
    const t = customText.trim();
    if (!t) {
      setError("保存する英文を入力してください。");
      return;
    }
    setError(null);
    if (savedTexts.includes(t)) {
      setInfoMsg("この英文はすでに保存されています。");
      return;
    }
    setSavedTexts((prev) => [t, ...prev].slice(0, SAVED_TEXTS_LIMIT));
    setInfoMsg("英文を保存しました。下の「保存済みの英文」から次回も呼び出せます。");
  }

  function loadSavedText(text: string) {
    if (busy) return;
    setCustomText(text);
    resetAttemptState();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteSavedText(text: string) {
    setSavedTexts((prev) => prev.filter((t) => t !== text));
  }

  function clearAllSavedTexts() {
    setSavedTexts([]);
    setConfirmClearSaved(false);
    setInfoMsg("保存済みの英文をすべて削除しました。");
  }

  return {
    savedTexts,
    savedTextsOpen,
    setSavedTextsOpen,
    confirmClearSaved,
    setConfirmClearSaved,
    isCurrentTextSaved,
    clearPracticeText,
    saveCurrentText,
    loadSavedText,
    deleteSavedText,
    clearAllSavedTexts,
  };
}
