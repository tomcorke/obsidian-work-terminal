import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionPersistence } from "./SessionPersistence";
import { mergeAndSavePluginData } from "../PluginDataStore";

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

function makePersisted(
  overrides: Partial<{
    taskPath: string;
    agentSessionId: string;
    label: string;
    sessionType: string;
    savedAt: string;
  }> = {},
) {
  return {
    version: 1 as const,
    taskPath: overrides.taskPath ?? "tasks/my-task.md",
    agentSessionId: overrides.agentSessionId ?? "session-1",
    label: overrides.label ?? "Claude",
    sessionType: (overrides.sessionType ?? "claude") as any,
    savedAt: overrides.savedAt ?? new Date().toISOString(),
  };
}

describe("SessionPersistence", () => {
  describe("saveToDisk", () => {
    it("saves resumable agent sessions with session IDs", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: true,
          agentSessionId: "s1",
          label: "Claude",
          taskPath: "task-1",
          sessionType: "claude",
        },
        {
          isResumableAgent: true,
          agentSessionId: "s2",
          label: "Copilot",
          taskPath: "task-1",
          sessionType: "copilot",
        },
        {
          isResumableAgent: false,
          agentSessionId: null,
          label: "Shell",
          taskPath: "task-1",
          sessionType: "shell",
        },
        {
          isResumableAgent: true,
          agentSessionId: null,
          label: "Claude2",
          taskPath: "task-1",
          sessionType: "claude",
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.persistedSessions).toHaveLength(2);
      expect(saved.persistedSessions[0].agentSessionId).toBe("s1");
      expect(saved.persistedSessions[1].agentSessionId).toBe("s2");
      expect(saved.persistedSessions[1].sessionType).toBe("copilot");
    });

    it("merges into existing plugin data without clobbering", async () => {
      const plugin = createMockPlugin({ settings: { foo: "bar" } });
      const sessions = new Map<string, any[]>();

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.settings).toEqual({ foo: "bar" });
      expect(saved.persistedSessions).toEqual([]);
    });

    it("shares the queued merge path with other plugin data writes", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: true,
          agentSessionId: "s1",
          label: "Claude",
          taskPath: "task-1",
          sessionType: "claude",
        },
      ]);

      await Promise.all([
        SessionPersistence.saveToDisk(plugin, sessions),
        mergeAndSavePluginData(plugin, async (data) => {
          data.settings = { foo: "bar" };
        }),
      ]);

      expect(plugin._getData()).toEqual({
        settings: { foo: "bar" },
        persistedSessions: [
          expect.objectContaining({
            agentSessionId: "s1",
            sessionType: "claude",
          }),
        ],
      });
    });
  });

  describe("loadFromDisk", () => {
    it("prunes sessions older than 7 days", async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      const plugin = createMockPlugin({
        persistedSessions: [
          makePersisted({ agentSessionId: "old", savedAt: old }),
          makePersisted({ agentSessionId: "new", savedAt: recent }),
        ],
      });

      const result = await SessionPersistence.loadFromDisk(plugin);
      expect(result).toHaveLength(1);
      expect(result[0].agentSessionId).toBe("new");
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
