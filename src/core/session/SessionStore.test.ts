// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "./SessionStore";
import type { StoredSession } from "./types";

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    taskPath: "tasks/test.md",
    label: "Shell",
    sessionType: "shell",
    terminal: {} as any,
    fitAddon: {} as any,
    searchAddon: {} as any,
    containerEl: {} as any,
    process: null,
    documentListeners: [],
    resizeObserver: {} as any,
    ...overrides,
  };
}

describe("SessionStore", () => {
  beforeEach(() => {
    delete window.__workTerminalStore;
  });

  afterEach(() => {
    delete window.__workTerminalStore;
    vi.restoreAllMocks();
  });

  describe("isReload", () => {
    it("returns false when no store exists", () => {
      expect(SessionStore.isReload()).toBe(false);
    });

    it("returns true when store exists", () => {
      window.__workTerminalStore = {
        sessions: new Map(),
        activeTaskPath: null,
        activeTabIndex: 0,
      };
      expect(SessionStore.isReload()).toBe(true);
    });
  });

  describe("stash", () => {
    it("stores sessions in window global", () => {
      const sessions = new Map([["item-1", [makeSession()]]]);
      SessionStore.stash(sessions, "tasks/test.md", 0);

      expect(window.__workTerminalStore).toBeDefined();
      expect(window.__workTerminalStore!.sessions.size).toBe(1);
      expect(window.__workTerminalStore!.activeTaskPath).toBe("tasks/test.md");
      expect(window.__workTerminalStore!.activeTabIndex).toBe(0);
    });

    it("merges with existing sessions", () => {
      const existing = new Map([["item-1", [makeSession({ id: "sess-a" })]]]);
      window.__workTerminalStore = {
        sessions: existing,
        activeTaskPath: "tasks/old.md",
        activeTabIndex: 1,
      };

      const newSessions = new Map([["item-2", [makeSession({ id: "sess-b" })]]]);
      SessionStore.stash(newSessions, "tasks/new.md", 2);

      expect(window.__workTerminalStore!.sessions.size).toBe(2);
      expect(window.__workTerminalStore!.sessions.has("item-1")).toBe(true);
      expect(window.__workTerminalStore!.sessions.has("item-2")).toBe(true);
    });

    it("appends tabs for the same item ID", () => {
      const existing = new Map([["item-1", [makeSession({ id: "sess-a" })]]]);
      window.__workTerminalStore = {
        sessions: existing,
        activeTaskPath: null,
        activeTabIndex: 0,
      };

      const newSessions = new Map([["item-1", [makeSession({ id: "sess-b" })]]]);
      SessionStore.stash(newSessions, null, 0);

      const tabs = window.__workTerminalStore!.sessions.get("item-1")!;
      expect(tabs).toHaveLength(2);
      expect(tabs[0].id).toBe("sess-a");
      expect(tabs[1].id).toBe("sess-b");
    });

    it("preserves existing activeTaskPath when new is null", () => {
      window.__workTerminalStore = {
        sessions: new Map(),
        activeTaskPath: "tasks/old.md",
        activeTabIndex: 3,
      };

      SessionStore.stash(new Map(), null, 0);

      expect(window.__workTerminalStore!.activeTaskPath).toBe("tasks/old.md");
      expect(window.__workTerminalStore!.activeTabIndex).toBe(3);
    });

    it("overrides activeTaskPath when new value is non-null", () => {
      window.__workTerminalStore = {
        sessions: new Map(),
        activeTaskPath: "tasks/old.md",
        activeTabIndex: 3,
      };

      SessionStore.stash(new Map(), "tasks/new.md", 5);

      expect(window.__workTerminalStore!.activeTaskPath).toBe("tasks/new.md");
      expect(window.__workTerminalStore!.activeTabIndex).toBe(5);
    });
  });

  describe("retrieve", () => {
    it("returns null when no store exists", () => {
      expect(SessionStore.retrieve()).toBeNull();
    });

    it("returns stored state", () => {
      const sessions = new Map([["item-1", [makeSession()]]]);
      window.__workTerminalStore = {
        sessions,
        activeTaskPath: "tasks/test.md",
        activeTabIndex: 2,
      };

      const result = SessionStore.retrieve();
      expect(result).not.toBeNull();
      expect(result!.sessions.size).toBe(1);
      expect(result!.activeTaskPath).toBe("tasks/test.md");
      expect(result!.activeTabIndex).toBe(2);
    });

    it("clears store after retrieval (delete-after-read)", () => {
      window.__workTerminalStore = {
        sessions: new Map(),
        activeTaskPath: null,
        activeTabIndex: 0,
      };

      SessionStore.retrieve();
      expect(window.__workTerminalStore).toBeUndefined();
    });

    it("returns null on second retrieval", () => {
      window.__workTerminalStore = {
        sessions: new Map(),
        activeTaskPath: null,
        activeTabIndex: 0,
      };

      SessionStore.retrieve();
      expect(SessionStore.retrieve()).toBeNull();
    });
  });
});
