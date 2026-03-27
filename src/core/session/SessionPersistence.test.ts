import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionPersistence } from "./SessionPersistence";

/** Minimal mock of the DataPlugin interface */
function createMockPlugin(initialData: Record<string, any> = {}) {
  let data = { ...initialData };
  return {
    loadData: vi.fn(async () => ({ ...data })),
    saveData: vi.fn(async (d: any) => {
      data = d;
    }),
    _getData: () => data,
  };
}

function makePersisted(overrides: Partial<{
  taskPath: string;
  claudeSessionId: string;
  label: string;
  sessionType: string;
  savedAt: string;
}> = {}) {
  return {
    version: 1 as const,
    taskPath: overrides.taskPath ?? "tasks/my-task.md",
    claudeSessionId: overrides.claudeSessionId ?? "session-1",
    label: overrides.label ?? "Claude",
    sessionType: (overrides.sessionType ?? "claude") as any,
    savedAt: overrides.savedAt ?? new Date().toISOString(),
  };
}

describe("SessionPersistence", () => {
  describe("saveToDisk", () => {
    it("saves only claude sessions with session IDs", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        { isClaudeSession: true, claudeSessionId: "s1", label: "Claude", taskPath: "task-1", sessionType: "claude" },
        { isClaudeSession: false, claudeSessionId: null, label: "Shell", taskPath: "task-1", sessionType: "shell" },
        { isClaudeSession: true, claudeSessionId: null, label: "Claude2", taskPath: "task-1", sessionType: "claude" },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.persistedSessions).toHaveLength(1);
      expect(saved.persistedSessions[0].claudeSessionId).toBe("s1");
    });

    it("merges into existing plugin data without clobbering", async () => {
      const plugin = createMockPlugin({ settings: { foo: "bar" } });
      const sessions = new Map<string, any[]>();

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.settings).toEqual({ foo: "bar" });
      expect(saved.persistedSessions).toEqual([]);
    });
  });

  describe("loadFromDisk", () => {
    it("prunes sessions older than 7 days", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      const plugin = createMockPlugin({
        persistedSessions: [
          makePersisted({ claudeSessionId: "old", savedAt: old }),
          makePersisted({ claudeSessionId: "new", savedAt: recent }),
        ],
      });

      const result = await SessionPersistence.loadFromDisk(plugin);
      expect(result).toHaveLength(1);
      expect(result[0].claudeSessionId).toBe("new");
    });

    it("returns empty array when no persisted data", async () => {
      const plugin = createMockPlugin();
      const result = await SessionPersistence.loadFromDisk(plugin);
      expect(result).toEqual([]);
    });
  });

  describe("clearPersistedFromDisk", () => {
    it("removes persistedSessions key from plugin data", async () => {
      const plugin = createMockPlugin({
        settings: { x: 1 },
        persistedSessions: [makePersisted()],
      });

      await SessionPersistence.clearPersistedFromDisk(plugin);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.persistedSessions).toBeUndefined();
      expect(saved.settings).toEqual({ x: 1 });
    });
  });

  describe("startPeriodicPersist", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("calls persistFn on the configured interval", async () => {
      const persistFn = vi.fn(async () => {});
      const stop = SessionPersistence.startPeriodicPersist(persistFn, 30_000);

      expect(persistFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(persistFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(persistFn).toHaveBeenCalledTimes(2);

      stop();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(persistFn).toHaveBeenCalledTimes(2); // no more calls after stop
    });

    it("stop function clears the interval", () => {
      const persistFn = vi.fn(async () => {});
      const stop = SessionPersistence.startPeriodicPersist(persistFn, 1000);
      stop();

      vi.advanceTimersByTime(5000);
      expect(persistFn).not.toHaveBeenCalled();
    });
  });
});
