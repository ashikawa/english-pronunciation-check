// localStorage persistence for the per-device stores.
//
// Everything in this module is a per-device convenience kept in the
// browser, NOT in the server database: the Notion destination list,
// the practice-text draft + saved-texts list, and the recognition
// failure log. The storage KEYS and value formats are a compatibility
// contract — changing them would hide data the user already has on
// their device — so they must stay exactly as they are.

// --- Notion save destinations ---

export type Destination = {
  pageId: string;
  title: string;
  url: string;
  path: string | null;
  isDefault: boolean;
};

export const DEST_STORAGE_KEY = "notion-destinations-v1";

export function loadStoredDestinations(): Destination[] {
  try {
    const raw = window.localStorage.getItem(DEST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Destination[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.pageId === "string" &&
        rec.pageId !== "" &&
        typeof rec.title === "string" &&
        typeof rec.url === "string"
      ) {
        out.push({
          pageId: rec.pageId,
          title: rec.title,
          url: rec.url,
          path: typeof rec.path === "string" ? rec.path : null,
          isDefault: rec.isDefault === true,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function storeDestinations(destinations: Destination[]) {
  try {
    window.localStorage.setItem(DEST_STORAGE_KEY, JSON.stringify(destinations));
  } catch {
    // Storage full or unavailable: the picker still works for this session.
  }
}

// --- Practice text ---

export const PRACTICE_TEXT_KEY = "practice-text-v1";
export const SAVED_TEXTS_KEY = "saved-practice-texts-v1";
export const SAVED_TEXTS_LIMIT = 50;

export function loadStoredPracticeText(): string {
  try {
    return window.localStorage.getItem(PRACTICE_TEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storePracticeText(text: string) {
  try {
    if (text) {
      window.localStorage.setItem(PRACTICE_TEXT_KEY, text);
    } else {
      window.localStorage.removeItem(PRACTICE_TEXT_KEY);
    }
  } catch {
    // Storage unavailable: the text still works for this session.
  }
}

export function loadStoredSavedTexts(): string[] {
  try {
    const raw = window.localStorage.getItem(SAVED_TEXTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const t = item.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= SAVED_TEXTS_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function storeSavedTexts(texts: string[]) {
  try {
    if (texts.length > 0) {
      window.localStorage.setItem(SAVED_TEXTS_KEY, JSON.stringify(texts));
    } else {
      window.localStorage.removeItem(SAVED_TEXTS_KEY);
    }
  } catch {
    // Storage unavailable: the list still works for this session.
  }
}

// --- Recognition failure log ---
// When a take ends with an empty transcript, its diagnostic summary
// (duration, session counts, mic peak level, error code) is appended
// here so the failure survives a page reload and can be reported
// verbatim later.

export const FAILURE_LOG_KEY = "recognition-failure-log-v1";
export const FAILURE_LOG_LIMIT = 20;

export type FailureLogEntry = { at: string; summary: string };

export function loadStoredFailureLog(): FailureLogEntry[] {
  try {
    const raw = window.localStorage.getItem(FAILURE_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: FailureLogEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.at === "string" && typeof rec.summary === "string" && rec.summary) {
        out.push({ at: rec.at, summary: rec.summary });
      }
      if (out.length >= FAILURE_LOG_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function storeFailureLog(entries: FailureLogEntry[]) {
  try {
    if (entries.length > 0) {
      window.localStorage.setItem(FAILURE_LOG_KEY, JSON.stringify(entries));
    } else {
      window.localStorage.removeItem(FAILURE_LOG_KEY);
    }
  } catch {
    // Storage unavailable: the log still works for this session.
  }
}
