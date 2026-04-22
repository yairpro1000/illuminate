import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERSISTED_LIST_VIEW_STATE,
  clearListViewState,
  clearSelectedListId,
  isPersistableListId,
  loadListViewState,
  loadSelectedListId,
  normalizeListViewState,
  resolvePreferredListId,
  saveListViewState,
  saveSelectedListId,
  shouldPersistListViewState,
} from "./viewState";
import type { ListInfo } from "./types";

class MemoryStorage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key) ?? null : null;
  }

  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

describe("listBrowser viewState", () => {
  const localStorage = new MemoryStorage();

  beforeEach(() => {
    (globalThis as { window?: { localStorage: Storage } }).window = {
      localStorage: localStorage as unknown as Storage,
    };
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    delete (globalThis as { window?: { localStorage: Storage } }).window;
  });

  function makeList(id: string, title = id): ListInfo {
    return {
      id,
      title,
      description: "",
      aliases: [],
      fields: {},
      meta: { revision: 1, itemsUpdatedAt: "", itemsUpdatedBy: null },
    };
  }

  it("returns normalized defaults when storage is empty", () => {
    expect(loadListViewState("list-a")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("returns normalized defaults when list id is empty", () => {
    expect(loadListViewState("")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
    expect(loadListViewState("   ")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("round-trips a valid version 1 payload", () => {
    saveListViewState("list-a", {
      filterText: "hello",
      filterPriority: 2,
      filterColor: "#ffffff",
      filterTopic: "topic",
      showArchived: true,
      sortLayers: [{ key: "priority", dir: "asc" }],
    });

    expect(loadListViewState("list-a")).toEqual({
      filterText: "hello",
      filterPriority: 2,
      filterColor: "#ffffff",
      filterTopic: "topic",
      showArchived: true,
      sortLayers: [{ key: "priority", dir: "asc" }],
    });
  });

  it("ignores invalid json", () => {
    localStorage.setItem("pa:list-browser:view:list-a", "{not-json");
    expect(loadListViewState("list-a")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("ignores malformed envelope shape", () => {
    localStorage.setItem("pa:list-browser:view:list-a", JSON.stringify({ version: 1 }));
    expect(loadListViewState("list-a")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("ignores unsupported version", () => {
    localStorage.setItem("pa:list-browser:view:list-a", JSON.stringify({
      version: 2,
      state: { filterText: "stale" },
    }));
    expect(loadListViewState("list-a")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("normalizes partial state", () => {
    expect(normalizeListViewState({ filterText: "hello", showArchived: 1 })).toEqual({
      filterText: "hello",
      filterPriority: "",
      filterColor: "",
      filterTopic: "",
      showArchived: true,
      sortLayers: [{ key: "createdAt", dir: "desc" }],
    });
  });

  it("normalizes malformed sort layers", () => {
    expect(normalizeListViewState({
      sortLayers: [{ key: "", dir: "asc" }, { key: "createdAt", dir: "sideways" }, "bad"],
    })).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("isolates storage by list id", () => {
    saveListViewState("list-a", { ...DEFAULT_PERSISTED_LIST_VIEW_STATE, filterText: "alpha" });
    saveListViewState("list-b", { ...DEFAULT_PERSISTED_LIST_VIEW_STATE, filterText: "beta" });

    expect(loadListViewState("list-a").filterText).toBe("alpha");
    expect(loadListViewState("list-b").filterText).toBe("beta");
  });

  it("does not write for empty or invalid list id", () => {
    saveListViewState("", { ...DEFAULT_PERSISTED_LIST_VIEW_STATE, filterText: "noop" });
    saveListViewState("   ", { ...DEFAULT_PERSISTED_LIST_VIEW_STATE, filterText: "noop" });

    expect(localStorage.length).toBe(0);
    expect(isPersistableListId("")).toBe(false);
    expect(isPersistableListId("   ")).toBe(false);
  });

  it("clears saved state for a list", () => {
    saveListViewState("list-a", { ...DEFAULT_PERSISTED_LIST_VIEW_STATE, filterText: "alpha" });
    clearListViewState("list-a");
    expect(loadListViewState("list-a")).toEqual(DEFAULT_PERSISTED_LIST_VIEW_STATE);
  });

  it("round-trips the selected list id", () => {
    saveSelectedListId("list-a");
    expect(loadSelectedListId()).toBe("list-a");
    clearSelectedListId();
    expect(loadSelectedListId()).toBe("");
  });

  it("does not write selected list id for an empty value", () => {
    saveSelectedListId("");
    saveSelectedListId("   ");
    expect(loadSelectedListId()).toBe("");
  });

  it("keeps the current list when it still exists", () => {
    const lists = [makeList("groceries"), makeList("work")];
    saveSelectedListId("work");
    expect(resolvePreferredListId(lists, "groceries")).toBe("groceries");
  });

  it("restores the persisted selected list when current is empty", () => {
    const lists = [makeList("groceries"), makeList("work")];
    saveSelectedListId("work");
    expect(resolvePreferredListId(lists, "")).toBe("work");
  });

  it("falls back to groceries when persisted selection no longer exists", () => {
    const lists = [makeList("work"), makeList("groceries"), makeList("translate", "Translate")];
    saveSelectedListId("missing");
    expect(resolvePreferredListId(lists, "")).toBe("groceries");
  });

  it("falls back to the first available list when groceries does not exist", () => {
    const lists = [makeList("work"), makeList("translate", "Translate")];
    expect(resolvePreferredListId(lists, "")).toBe("work");
  });

  it("matches groceries by title as well as id", () => {
    const lists = [makeList("list-123", "Groceries"), makeList("work")];
    expect(resolvePreferredListId(lists, "")).toBe("list-123");
  });

  it("only persists after hydration completes for the active list", () => {
    expect(shouldPersistListViewState({
      listId: "list-a",
      hydratedListId: "",
      searchAllLists: false,
      reorderMode: false,
    })).toBe(false);
    expect(shouldPersistListViewState({
      listId: "list-a",
      hydratedListId: "list-b",
      searchAllLists: false,
      reorderMode: false,
    })).toBe(false);
    expect(shouldPersistListViewState({
      listId: "list-a",
      hydratedListId: "list-a",
      searchAllLists: false,
      reorderMode: false,
    })).toBe(true);
  });

  it("skips persistence for all-lists search and reorder mode", () => {
    expect(shouldPersistListViewState({
      listId: "list-a",
      hydratedListId: "list-a",
      searchAllLists: true,
      reorderMode: false,
    })).toBe(false);
    expect(shouldPersistListViewState({
      listId: "list-a",
      hydratedListId: "list-a",
      searchAllLists: false,
      reorderMode: true,
    })).toBe(false);
  });
});
