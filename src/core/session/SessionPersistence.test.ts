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
    agentSessionId: string | null;
    claudeSessionId: string | null;
    label: string;
    sessionType: string;
    savedAt: string;
    recoveryMode: "resume" | "relaunch";
    cwd: string;
    command: string;
    commandArgs: string[] | undefined;
    durableSessionId: string;
    durableSessionIdGenerated: boolean;
    profileId: string;
    profileColor: string;
    paramPassMode: string;
  }> = {},
) {
  const sessionId = overrides.agentSessionId ?? overrides.claudeSessionId ?? "session-1";
  return {
    version: 2 as const,
    taskPath: overrides.taskPath ?? "tasks/my-task.md",
    agentSessionId: sessionId,
    claudeSessionId: sessionId,
    durableSessionId: overrides.durableSessionId,
    label: overrides.label ?? "Claude",
    sessionType: (overrides.sessionType ?? "claude") as any,
    savedAt: overrides.savedAt ?? new Date().toISOString(),
    recoveryMode: overrides.recoveryMode ?? "resume",
    cwd: overrides.cwd ?? "/vault",
    command: overrides.command ?? "claude",
    commandArgs: overrides.commandArgs ?? ["claude", "--resume", "session-1"],
    durableSessionIdGenerated: overrides.durableSessionIdGenerated,
    profileId: overrides.profileId,
    profileColor: overrides.profileColor,
    paramPassMode: overrides.paramPassMode,
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
          launchShell: "claude",
          launchCwd: "/vault",
          launchCommandArgs: ["claude", "--resume", "s1"],
        },
        {
          isResumableAgent: true,
          agentSessionId: "s2",
          label: "Copilot",
          taskPath: "task-1",
          sessionType: "copilot",
          launchShell: "copilot",
          launchCwd: "/vault",
          launchCommandArgs: ["copilot", "--resume=s2"],
        },
        {
          isResumableAgent: false,
          agentSessionId: null,
          label: "Shell",
          taskPath: "task-1",
          sessionType: "shell",
          launchShell: "/bin/zsh",
          launchCwd: "/vault",
        },
        {
          isResumableAgent: true,
          agentSessionId: null,
          label: "Claude2",
          taskPath: "task-1",
          sessionType: "claude",
          launchShell: "claude",
          launchCwd: "/vault",
          launchCommandArgs: ["claude"],
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.persistedSessions).toHaveLength(4);
      expect(saved.persistedSessions[0].claudeSessionId).toBe("s1");
      expect(saved.persistedSessions[0].agentSessionId).toBe("s1");
      expect(saved.persistedSessions[1].agentSessionId).toBe("s2");
      expect(saved.persistedSessions[1].claudeSessionId).toBe("s2");
      expect(saved.persistedSessions[1].sessionType).toBe("copilot");
      expect(saved.persistedSessions[1].label).toBe("Copilot");
      expect(saved.persistedSessions[2]).toMatchObject({
        sessionType: "shell",
        recoveryMode: "relaunch",
        durableSessionId: expect.any(String),
        command: "/bin/zsh",
        cwd: "/vault",
      });
      expect(saved.persistedSessions[3]).toMatchObject({
        sessionType: "claude",
        recoveryMode: "relaunch",
        durableSessionId: expect.any(String),
        command: "claude",
      });
    });

    it("round-trips Copilot session with correct label and sessionType", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: true,
          agentSessionId: "copilot-session-1",
          label: "Copilot",
          taskPath: "task-1",
          sessionType: "copilot",
          launchShell: "copilot",
          launchCwd: "/vault",
          launchCommandArgs: ["copilot", "--resume=copilot-session-1"],
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);

      const loaded = await SessionPersistence.loadFromDisk(plugin);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({
        sessionType: "copilot",
        label: "Copilot",
        agentSessionId: "copilot-session-1",
        claudeSessionId: "copilot-session-1",
        recoveryMode: "resume",
      });
    });

    it("saves profileColor when present on a tab", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: false,
          agentSessionId: null,
          label: "Shell",
          taskPath: "task-1",
          sessionType: "shell",
          launchShell: "/bin/zsh",
          launchCwd: "/vault",
          profileColor: "#e67e22",
        },
        {
          isResumableAgent: true,
          agentSessionId: "s1",
          label: "Claude",
          taskPath: "task-1",
          sessionType: "claude",
          launchShell: "claude",
          launchCwd: "/vault",
          launchCommandArgs: ["claude", "--resume", "s1"],
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.persistedSessions[0].profileColor).toBe("#e67e22");
      expect(saved.persistedSessions[1].profileColor).toBeUndefined();
    });

    it("merges into existing plugin data without clobbering", async () => {
      const plugin = createMockPlugin({ settings: { foo: "bar" } });
      const sessions = new Map<string, any[]>();

      await SessionPersistence.saveToDisk(plugin, sessions);

      const saved = plugin.saveData.mock.calls[0][0];
      expect(saved.settings).toEqual({ foo: "bar" });
      expect(saved.persistedSessions).toEqual([]);
    });

    it("preserves preloaded persisted sessions when there are no active tabs yet", async () => {
      const existing = makePersisted({
        taskPath: "tasks/cold-start.md",
        sessionType: "shell",
        claudeSessionId: null,
        recoveryMode: "relaunch",
        label: "Cold shell",
        command: "/bin/zsh",
        commandArgs: undefined,
        durableSessionId: "durable-cold-shell",
      });
      const plugin = createMockPlugin({ persistedSessions: [existing] });

      await SessionPersistence.saveToDisk(plugin, new Map());

      expect(plugin._getData().persistedSessions).toEqual([existing]);
    });

    it("replaces a matching pending relaunch entry with the active session identity", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: false,
          claudeSessionId: null,
          durableSessionId: "durable-shell-1",
          label: "Shell",
          taskPath: "task-1",
          sessionType: "shell",
          launchShell: "/bin/zsh",
          launchCwd: "/vault",
        },
      ]);

      const merged = SessionPersistence.mergePersistedSessions(
        [
          makePersisted({
            taskPath: "task-1",
            sessionType: "shell",
            claudeSessionId: null,
            recoveryMode: "relaunch",
            label: "Shell",
            command: "/bin/zsh",
            commandArgs: undefined,
            durableSessionId: "durable-shell-1",
          }),
          makePersisted({
            taskPath: "task-1",
            sessionType: "shell",
            claudeSessionId: null,
            recoveryMode: "relaunch",
            label: "Shell",
            command: "/bin/zsh",
            commandArgs: undefined,
            durableSessionId: "durable-shell-2",
          }),
        ],
        sessions,
      );

      expect(merged).toHaveLength(2);
      expect(merged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ durableSessionId: "durable-shell-1" }),
          expect.objectContaining({ durableSessionId: "durable-shell-2" }),
        ]),
      );
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
          launchShell: "claude",
          launchCwd: "/vault",
          launchCommandArgs: ["claude", "--resume", "s1"],
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
            claudeSessionId: "s1",
            sessionType: "claude",
            recoveryMode: "resume",
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

    it("normalizes legacy resumable entries without a recovery mode", async () => {
      const plugin = createMockPlugin({
        persistedSessions: [
          {
            version: 1,
            taskPath: "tasks/my-task.md",
            claudeSessionId: "legacy-session",
            label: "Claude",
            sessionType: "claude",
            savedAt: new Date().toISOString(),
          },
        ],
      });

      const result = await SessionPersistence.loadFromDisk(plugin);
      expect(result).toEqual([
        expect.objectContaining({
          claudeSessionId: "legacy-session",
          recoveryMode: "resume",
        }),
      ]);
    });

    it("assigns durable relaunch identities to legacy relaunch entries", async () => {
      const plugin = createMockPlugin({
        persistedSessions: [
          {
            version: 2,
            taskPath: "tasks/my-task.md",
            claudeSessionId: null,
            label: "Shell",
            sessionType: "shell",
            savedAt: new Date().toISOString(),
            recoveryMode: "relaunch",
            cwd: "/vault",
            command: "/bin/zsh",
          },
          {
            version: 2,
            taskPath: "tasks/my-task.md",
            claudeSessionId: null,
            label: "Shell",
            sessionType: "shell",
            savedAt: new Date().toISOString(),
            recoveryMode: "relaunch",
            cwd: "/vault",
            command: "/bin/zsh",
          },
        ],
      });

      const result = await SessionPersistence.loadFromDisk(plugin);
      expect(result).toHaveLength(2);
      expect(result[0].durableSessionId).toEqual(expect.any(String));
      expect(result[1].durableSessionId).toEqual(expect.any(String));
      expect(result[0].durableSessionId).not.toBe(result[1].durableSessionId);
    });

    it("preserves synthesized relaunch provenance across persist and reload", async () => {
      const plugin = createMockPlugin({
        persistedSessions: [
          {
            version: 2,
            taskPath: "tasks/my-task.md",
            claudeSessionId: null,
            label: "Shell",
            sessionType: "shell",
            savedAt: new Date().toISOString(),
            recoveryMode: "relaunch",
            cwd: "/vault",
            command: "/bin/zsh",
          },
        ],
      });

      const [loaded] = await SessionPersistence.loadFromDisk(plugin);
      expect(loaded).toMatchObject({
        durableSessionId: expect.any(String),
        durableSessionIdGenerated: true,
      });

      SessionPersistence.setPersistedSessions(plugin._getData(), [loaded]);

      const [reloaded] = await SessionPersistence.loadFromDisk(plugin);
      expect(reloaded).toMatchObject({
        durableSessionId: loaded.durableSessionId,
        durableSessionIdGenerated: true,
      });
    });

    it("round-trips profileColor through save and load", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: false,
          agentSessionId: null,
          label: "Shell",
          taskPath: "task-1",
          sessionType: "shell",
          launchShell: "/bin/zsh",
          launchCwd: "/vault",
          profileColor: "#3498db",
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);
      const result = await SessionPersistence.loadFromDisk(plugin);

      expect(result).toHaveLength(1);
      expect(result[0].profileColor).toBe("#3498db");
    });

    it("round-trips profileId through save and load", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: true,
          agentSessionId: "s1",
          label: "Claude",
          taskPath: "task-1",
          sessionType: "claude",
          launchShell: "claude",
          launchCwd: "/vault",
          launchCommandArgs: ["claude", "--resume", "s1"],
          profileId: "profile-abc",
          profileColor: "#e67e22",
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);
      const result = await SessionPersistence.loadFromDisk(plugin);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe("profile-abc");
      expect(result[0].profileColor).toBe("#e67e22");
    });

    it("omits profileId when not set on the tab", async () => {
      const plugin = createMockPlugin();
      const sessions = new Map<string, any[]>();
      sessions.set("task-1", [
        {
          isResumableAgent: false,
          agentSessionId: null,
          label: "Shell",
          taskPath: "task-1",
          sessionType: "shell",
          launchShell: "/bin/zsh",
          launchCwd: "/vault",
        },
      ]);

      await SessionPersistence.saveToDisk(plugin, sessions);
      const result = await SessionPersistence.loadFromDisk(plugin);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBeUndefined();
    });

    it("drops entries with invalid disk session types", async () => {
      const plugin = createMockPlugin({
        persistedSessions: [
          makePersisted({ sessionType: "claude" }),
          makePersisted({ sessionType: "not-a-session-type" }),
        ],
      });

      const result = await SessionPersistence.loadFromDisk(plugin);
      expect(result).toEqual([
        expect.objectContaining({
          sessionType: "claude",
        }),
      ]);
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
