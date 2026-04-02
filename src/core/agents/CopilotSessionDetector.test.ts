import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotSessionDetector } from "./CopilotSessionDetector";

// In-memory filesystem for testing
function createMockFs(files: Record<string, { content: string; mtimeMs: number }>) {
  return {
    existsSync: (dir: string) => dir in files || Object.keys(files).some((f) => f.startsWith(dir)),
    readdirSync: (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((f) => !f.includes("/"));
    },
    statSync: (path: string) => {
      const file = files[path];
      if (!file) throw new Error(`ENOENT: ${path}`);
      return { mtimeMs: file.mtimeMs, isFile: () => true };
    },
    readFileSync: (path: string) => {
      const file = files[path];
      if (!file) throw new Error(`ENOENT: ${path}`);
      return file.content;
    },
  } as unknown as typeof import("fs");
}

function createMockPath() {
  return {
    join: (...parts: string[]) => parts.join("/"),
  } as unknown as typeof import("path");
}

describe("CopilotSessionDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects session ID from a matching log file", () => {
    const spawnTime = 1000;
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const logContent = [
      "[INFO] Starting copilot...",
      `[INFO] OpenTelemetry tracker created for session ${sessionId}`,
      `[INFO] Workspace initialized: ${sessionId} (checkpoints: 0)`,
    ].join("\n");

    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: spawnTime },
      "/home/.copilot/logs/process-1000-12345.log": {
        content: logContent,
        mtimeMs: spawnTime + 500,
      },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    expect(callback).toHaveBeenCalledWith(sessionId);
  });

  it("ignores log files older than spawn time", () => {
    const spawnTime = 5000;
    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: 1000 },
      "/home/.copilot/logs/process-1000-99999.log": {
        content:
          "[INFO] Workspace initialized: old-session-id-that-should-not-match (checkpoints: 0)",
        mtimeMs: 1000, // older than spawnTime - 500
      },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    // Advance timers past several poll intervals
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
    detector.dispose();
  });

  it("ignores files that do not match the log name pattern", () => {
    const spawnTime = 1000;
    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: spawnTime },
      "/home/.copilot/logs/other-file.log": {
        content:
          "[INFO] Workspace initialized: a1b2c3d4-e5f6-7890-abcd-ef1234567890 (checkpoints: 0)",
        mtimeMs: spawnTime + 500,
      },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
    detector.dispose();
  });

  it("stops after max poll attempts", () => {
    const spawnTime = 1000;
    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: spawnTime },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    // Advance past 15 poll attempts (1s each + initial)
    vi.advanceTimersByTime(20000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("handles missing log directory gracefully", () => {
    const fs = createMockFs({});

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime: 1000,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;

    // Should not throw
    expect(() => {
      detector.start();
      vi.advanceTimersByTime(5000);
    }).not.toThrow();

    expect(callback).not.toHaveBeenCalled();
    detector.dispose();
  });

  it("disposes cleanly and stops polling", () => {
    const spawnTime = 1000;
    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: spawnTime },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();
    detector.dispose();

    // No further polling should happen
    vi.advanceTimersByTime(20000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("picks the newest log file when multiple match", () => {
    const spawnTime = 1000;
    const oldSessionId = "11111111-1111-1111-1111-111111111111";
    const newSessionId = "22222222-2222-2222-2222-222222222222";

    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: spawnTime },
      "/home/.copilot/logs/process-1000-111.log": {
        content: `[INFO] Workspace initialized: ${oldSessionId} (checkpoints: 0)`,
        mtimeMs: spawnTime + 100,
      },
      "/home/.copilot/logs/process-1500-222.log": {
        content: `[INFO] Workspace initialized: ${newSessionId} (checkpoints: 0)`,
        mtimeMs: spawnTime + 600,
      },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    // Should detect the newest file's session ID
    expect(callback).toHaveBeenCalledWith(newSessionId);
  });

  it("stops after 3 consecutive readFileSync errors without calling callback", () => {
    const spawnTime = 1000;
    // Create a filesystem where readFileSync always throws but statSync works
    const fs = {
      existsSync: () => true,
      readdirSync: () => ["process-1000-111.log"],
      statSync: () => ({ mtimeMs: spawnTime + 500, isFile: () => true }),
      readFileSync: () => {
        throw new Error("ENOENT: file vanished");
      },
    } as unknown as typeof import("fs");

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    // Advance through 3 poll intervals (initial + 2 more = 3 consecutive errors)
    vi.advanceTimersByTime(3000);

    expect(callback).not.toHaveBeenCalled();
  });

  it("skips individual unreadable files without counting as a poll error", () => {
    const spawnTime = 1000;
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    // First file throws on read, second file has the session ID
    const fileContents: Record<string, string | null> = {
      "/home/.copilot/logs/process-1000-111.log": null, // will throw
      "/home/.copilot/logs/process-1500-222.log": `[INFO] Workspace initialized: ${sessionId} (checkpoints: 0)`,
    };

    const fs = {
      existsSync: () => true,
      readdirSync: () => ["process-1000-111.log", "process-1500-222.log"],
      statSync: (path: string) => {
        const mtime = path.includes("111") ? spawnTime + 100 : spawnTime + 500;
        return { mtimeMs: mtime, isFile: () => true };
      },
      readFileSync: (path: string) => {
        const content = fileContents[path];
        if (content === null) throw new Error("ENOENT: file deleted");
        return content;
      },
    } as unknown as typeof import("fs");

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    const callback = vi.fn();
    detector.onSessionDetected = callback;
    detector.start();

    // Should still detect the session from the readable file
    expect(callback).toHaveBeenCalledWith(sessionId);
  });

  it("wires callback to set agentSessionId on a tab-like object", () => {
    // Integration-style test: verify the TerminalTab callback wiring pattern.
    // TerminalTab._initDeferredSessionDetector sets onSessionDetected to assign
    // agentSessionId. We simulate the same wiring here without instantiating
    // a full TerminalTab (which requires xterm, PTY, DOM, etc.).
    const spawnTime = 1000;
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    const fs = createMockFs({
      "/home/.copilot/logs": { content: "", mtimeMs: spawnTime },
      "/home/.copilot/logs/process-1000-12345.log": {
        content: `[INFO] Workspace initialized: ${sessionId} (checkpoints: 0)`,
        mtimeMs: spawnTime + 500,
      },
    });

    const detector = new CopilotSessionDetector({
      logDir: "/home/.copilot/logs",
      logPattern: "Workspace initialized: ([0-9a-f-]{36})",
      spawnTime,
      deps: { fs, pathModule: createMockPath() },
    });

    // Simulate the TerminalTab wiring: callback assigns agentSessionId
    const tabState = {
      agentSessionId: null as string | null,
      detectorRef: detector as CopilotSessionDetector | null,
    };
    detector.onSessionDetected = (id) => {
      tabState.agentSessionId = id;
      tabState.detectorRef = null;
    };
    detector.start();

    expect(tabState.agentSessionId).toBe(sessionId);
    expect(tabState.detectorRef).toBeNull();
  });
});
