// Unit tests for the localStorage stores in client/src/lib/storage.ts.
//
// Scope: the load/store pairs for the three per-device stores — the
// Notion destination list, the practice-text draft + saved-texts
// list, and the recognition failure log. The logic worth pinning is
// the validation on load (malformed or stale data must degrade to an
// empty store, never throw or leak bad entries into the UI), the
// de-duplication, and the size caps. The stores run against an
// in-memory localStorage stub installed as window.localStorage;
// nothing here touches a real browser or the server.
//
// The storage KEYS are a compatibility contract (changing one would
// hide data already on the user's device), so the tests assert the
// literal keys as well as the exported constants.
//
// Tests live under client/tests/ (mirroring client/src/), following
// the server/tests/ precedent. Run with: bun run test
// (bun test server/tests client/tests)

import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEST_STORAGE_KEY,
  FAILURE_LOG_KEY,
  FAILURE_LOG_LIMIT,
  PRACTICE_TEXT_KEY,
  SAVED_TEXTS_KEY,
  SAVED_TEXTS_LIMIT,
  loadStoredDestinations,
  loadStoredFailureLog,
  loadStoredPracticeText,
  loadStoredSavedTexts,
  storeDestinations,
  storeFailureLog,
  storePracticeText,
  storeSavedTexts,
  type Destination,
} from "../../src/lib/storage";

// --- In-memory localStorage stub ---

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

let mem: MemoryStorage;

function installWindow(localStorage: unknown): void {
  (globalThis as unknown as { window: { localStorage: unknown } }).window = {
    localStorage,
  };
}

beforeEach(() => {
  mem = new MemoryStorage();
  installWindow(mem);
});

describe("storage keys (compatibility contract)", () => {
  test("the keys stay exactly as existing devices have them", () => {
    expect(DEST_STORAGE_KEY).toBe("notion-destinations-v1");
    expect(PRACTICE_TEXT_KEY).toBe("practice-text-v1");
    expect(SAVED_TEXTS_KEY).toBe("saved-practice-texts-v1");
    expect(FAILURE_LOG_KEY).toBe("recognition-failure-log-v1");
  });
});

describe("Notion destinations", () => {
  const dest = (over: Partial<Destination> = {}): Destination => ({
    pageId: "page-1",
    title: "TED",
    url: "https://example.com/page-1",
    path: null,
    isDefault: false,
    ...over,
  });

  test("no stored value loads as an empty list", () => {
    expect(loadStoredDestinations()).toEqual([]);
  });

  test("store → load round-trips the list", () => {
    const list = [
      dest({ isDefault: true, path: "Parent / TED" }),
      dest({ pageId: "page-2", title: "Notes", url: "https://example.com/2" }),
    ];
    storeDestinations(list);
    expect(loadStoredDestinations()).toEqual(list);
    expect(mem.getItem(DEST_STORAGE_KEY)).toBe(JSON.stringify(list));
  });

  test("entries missing a pageId, title, or url are dropped; non-objects too", () => {
    mem.setItem(
      DEST_STORAGE_KEY,
      JSON.stringify([
        dest(),
        { title: "no id", url: "https://example.com" },
        { pageId: "", title: "empty id", url: "https://example.com" },
        { pageId: "p", title: 42, url: "https://example.com" },
        { pageId: "p", title: "t", url: null },
        "a string",
        null,
        42,
      ]),
    );
    expect(loadStoredDestinations()).toEqual([dest()]);
  });

  test("path falls back to null unless a string; isDefault only for literal true", () => {
    mem.setItem(
      DEST_STORAGE_KEY,
      JSON.stringify([
        { pageId: "a", title: "A", url: "u", path: 123, isDefault: "yes" },
        { pageId: "b", title: "B", url: "u", path: "P / B", isDefault: true },
        { pageId: "c", title: "C", url: "u" },
      ]),
    );
    expect(loadStoredDestinations()).toEqual([
      { pageId: "a", title: "A", url: "u", path: null, isDefault: false },
      { pageId: "b", title: "B", url: "u", path: "P / B", isDefault: true },
      { pageId: "c", title: "C", url: "u", path: null, isDefault: false },
    ]);
  });

  test("malformed JSON or a non-array value loads as an empty list", () => {
    mem.setItem(DEST_STORAGE_KEY, "{not json");
    expect(loadStoredDestinations()).toEqual([]);
    mem.setItem(DEST_STORAGE_KEY, JSON.stringify({ pageId: "x" }));
    expect(loadStoredDestinations()).toEqual([]);
  });
});

describe("practice text draft", () => {
  test("defaults to empty, stores, and storing empty removes the key", () => {
    expect(loadStoredPracticeText()).toBe("");
    storePracticeText("I will call you when I get home.");
    expect(loadStoredPracticeText()).toBe(
      "I will call you when I get home.",
    );
    storePracticeText("");
    expect(loadStoredPracticeText()).toBe("");
    expect(mem.getItem(PRACTICE_TEXT_KEY)).toBeNull();
  });
});

describe("saved practice texts", () => {
  test("no stored value loads as an empty list", () => {
    expect(loadStoredSavedTexts()).toEqual([]);
  });

  test("load trims entries, drops blanks and non-strings, and de-duplicates", () => {
    mem.setItem(
      SAVED_TEXTS_KEY,
      JSON.stringify([
        "  hello world  ",
        "",
        "   ",
        42,
        null,
        "hello world",
        "another one",
      ]),
    );
    expect(loadStoredSavedTexts()).toEqual(["hello world", "another one"]);
  });

  test("load caps the list at SAVED_TEXTS_LIMIT (50)", () => {
    const many = Array.from({ length: 60 }, (_, i) => `sentence ${i}`);
    mem.setItem(SAVED_TEXTS_KEY, JSON.stringify(many));
    const loaded = loadStoredSavedTexts();
    expect(loaded.length).toBe(SAVED_TEXTS_LIMIT);
    expect(loaded[0]).toBe("sentence 0");
    expect(loaded[SAVED_TEXTS_LIMIT - 1]).toBe("sentence 49");
  });

  test("malformed JSON loads as an empty list", () => {
    mem.setItem(SAVED_TEXTS_KEY, "[oops");
    expect(loadStoredSavedTexts()).toEqual([]);
  });

  test("store writes the list; storing an empty list removes the key", () => {
    storeSavedTexts(["one", "two"]);
    expect(loadStoredSavedTexts()).toEqual(["one", "two"]);
    storeSavedTexts([]);
    expect(mem.getItem(SAVED_TEXTS_KEY)).toBeNull();
    expect(loadStoredSavedTexts()).toEqual([]);
  });
});

describe("recognition failure log", () => {
  test("no stored value loads as an empty log", () => {
    expect(loadStoredFailureLog()).toEqual([]);
  });

  test("entries without a string timestamp or a non-empty summary are dropped", () => {
    mem.setItem(
      FAILURE_LOG_KEY,
      JSON.stringify([
        { at: "2026-11-19T00:00:00.000Z", summary: "認識結果が空でした" },
        { at: "2026-11-19T00:00:00.000Z", summary: "" },
        { at: 123, summary: "x" },
        { summary: "no timestamp" },
        "junk",
        null,
      ]),
    );
    expect(loadStoredFailureLog()).toEqual([
      { at: "2026-11-19T00:00:00.000Z", summary: "認識結果が空でした" },
    ]);
  });

  test("load caps the log at FAILURE_LOG_LIMIT (20), keeping the stored order", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      at: `2026-11-19T00:00:${String(i).padStart(2, "0")}.000Z`,
      summary: `failure ${i}`,
    }));
    mem.setItem(FAILURE_LOG_KEY, JSON.stringify(many));
    const loaded = loadStoredFailureLog();
    expect(loaded.length).toBe(FAILURE_LOG_LIMIT);
    expect(loaded[0]?.summary).toBe("failure 0");
    expect(loaded[FAILURE_LOG_LIMIT - 1]?.summary).toBe("failure 19");
  });

  test("store → load round-trips; storing an empty log removes the key", () => {
    const entries = [
      { at: "2026-11-19T00:00:00.000Z", summary: "認識結果が空でした" },
    ];
    storeFailureLog(entries);
    expect(loadStoredFailureLog()).toEqual(entries);
    storeFailureLog([]);
    expect(mem.getItem(FAILURE_LOG_KEY)).toBeNull();
    expect(loadStoredFailureLog()).toEqual([]);
  });
});

describe("unavailable storage", () => {
  test("a localStorage that throws degrades every load to its empty default and never throws on store", () => {
    const throwing = {
      getItem(): string | null {
        throw new Error("denied");
      },
      setItem(): void {
        throw new Error("denied");
      },
      removeItem(): void {
        throw new Error("denied");
      },
    };
    installWindow(throwing);
    expect(loadStoredDestinations()).toEqual([]);
    expect(loadStoredPracticeText()).toBe("");
    expect(loadStoredSavedTexts()).toEqual([]);
    expect(loadStoredFailureLog()).toEqual([]);
    expect(() => storeDestinations([])).not.toThrow();
    expect(() => storePracticeText("x")).not.toThrow();
    expect(() => storeSavedTexts(["x"])).not.toThrow();
    expect(() =>
      storeFailureLog([{ at: "t", summary: "s" }]),
    ).not.toThrow();
  });
});
