import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockStats = { mtimeMs: number };

const mockState = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const stats = new Map<string, MockStats>();
  const execSync = vi.fn();

  function ensureDir(dirPath: string): void {
    const normalized = path.normalize(dirPath);
    const parts = normalized.split(path.sep).filter(Boolean);
    let current = normalized.startsWith(path.sep) ? path.sep : "";
    dirs.add(normalized);
    for (const part of parts) {
      current =
        current === path.sep ? path.join(current, part) : current ? path.join(current, part) : part;
      dirs.add(current);
    }
  }

  function writeFile(filePath: string, content: string, mtimeMs = Date.now()): void {
    ensureDir(path.dirname(filePath));
    files.set(path.normalize(filePath), content);
    stats.set(path.normalize(filePath), { mtimeMs });
  }

  function setDir(dirPath: string): void {
    ensureDir(dirPath);
  }

  function reset(): void {
    files.clear();
    dirs.clear();
    stats.clear();
    execSync.mockReset();
  }

  const fs = {
    existsSync(filePath: string) {
      const normalized = path.normalize(filePath);
      return files.has(normalized) || dirs.has(normalized);
    },
    mkdirSync(dirPath: string) {
      ensureDir(dirPath);
    },
    writeFileSync(filePath: string, content: string, options?: { mode?: number }) {
      writeFile(filePath, content, options?.mode ?? Date.now());
    },
    readFileSync(filePath: string) {
      const normalized = path.normalize(filePath);
      const content = files.get(normalized);
      if (content == null) throw new Error(`ENOENT: ${filePath}`);
      return content;
    },
    unlinkSync(filePath: string) {
      const normalized = path.normalize(filePath);
      files.delete(normalized);
      stats.delete(normalized);
    },
    readdirSync(dirPath: string) {
      const normalizedDir = path.normalize(dirPath);
      return [...files.keys()]
        .filter((filePath) => path.dirname(filePath) === normalizedDir)
        .map((filePath) => path.basename(filePath));
    },
    statSync(filePath: string) {
      const stat = stats.get(path.normalize(filePath));
      if (!stat) throw new Error(`ENOENT: ${filePath}`);
      return stat;
    },
  };

  const childProcess = {
    execSync,
  };

  return {
    fs,
    childProcess,
    reset,
    writeFile,
    setDir,
    files,
    execSync,
  };
});

vi.mock("../utils", () => ({
  expandTilde: (value: string) => value.replace(/^~/, "/mock-home"),
  electronRequire: (moduleName: string) => {
    if (moduleName === "fs") return mockState.fs;
    if (moduleName === "path") return path;
    if (moduleName === "child_process") return mockState.childProcess;
    throw new Error(`Unexpected module request: ${moduleName}`);
  },
}));

import {
  checkHookStatus,
  cleanupStaleEvents,
  installHooks,
  readResumeEvent,
  removeHooks,
} from "./ClaudeHookManager";

const MOCK_CWD = "/repo/project";
const SETTINGS_PATH = path.join(MOCK_CWD, ".claude", "settings.local.json");
const SCRIPT_PATH = "/mock-home/.work-terminal/hooks/session-change.sh";
const EVENTS_DIR = "/mock-home/.work-terminal/events";

describe("ClaudeHookManager", () => {
  beforeEach(() => {
    mockState.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports missing script and hook settings when nothing is installed", () => {
    expect(checkHookStatus(MOCK_CWD)).toEqual({
      scriptExists: false,
      hooksConfigured: false,
    });
  });

  it("detects an installed script and configured SessionStart/SessionEnd hooks", () => {
    mockState.writeFile(SCRIPT_PATH, "#!/bin/bash");
    mockState.writeFile(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: SCRIPT_PATH }] }],
          SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: SCRIPT_PATH }] }],
        },
      }),
    );

    expect(checkHookStatus(MOCK_CWD)).toEqual({
      scriptExists: true,
      hooksConfigured: true,
    });
  });

  it("installs the hook script and merges hook settings without dropping unrelated data", async () => {
    mockState.writeFile(
      SETTINGS_PATH,
      JSON.stringify({
        theme: "moonstone",
        hooks: {
          OtherEvent: [{ hooks: [{ type: "command", command: "/existing.sh" }] }],
        },
      }),
    );

    await installHooks(MOCK_CWD);

    expect(mockState.files.get(SCRIPT_PATH)).toContain("SessionEnd");
    expect(mockState.execSync).toHaveBeenCalledWith(`chmod +x "${SCRIPT_PATH}"`);

    const settings = JSON.parse(mockState.files.get(SETTINGS_PATH) ?? "{}");
    expect(settings.theme).toBe("moonstone");
    expect(settings.hooks.OtherEvent).toEqual([
      { hooks: [{ type: "command", command: "/existing.sh" }] },
    ]);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe(SCRIPT_PATH);
    expect(settings.hooks.SessionStart[0]).toMatchObject({
      matcher: "resume",
      hooks: [{ type: "command", command: SCRIPT_PATH }],
    });
  });

  it("removes only the managed hooks and deletes the settings file if it becomes empty", async () => {
    mockState.writeFile(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: SCRIPT_PATH }] }],
          SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: SCRIPT_PATH }] }],
        },
      }),
    );
    mockState.writeFile(SCRIPT_PATH, "#!/bin/bash");

    await removeHooks(MOCK_CWD);

    expect(mockState.files.has(SETTINGS_PATH)).toBe(false);
    expect(mockState.files.has(SCRIPT_PATH)).toBe(false);
  });

  it("preserves unrelated settings while removing managed hooks", async () => {
    mockState.writeFile(
      SETTINGS_PATH,
      JSON.stringify({
        theme: "moonstone",
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: SCRIPT_PATH }] }],
          SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: SCRIPT_PATH }] }],
          OtherEvent: [{ hooks: [{ type: "command", command: "/existing.sh" }] }],
        },
      }),
    );
    mockState.writeFile(SCRIPT_PATH, "#!/bin/bash");

    await removeHooks(MOCK_CWD);

    const settings = JSON.parse(mockState.files.get(SETTINGS_PATH) ?? "{}");
    expect(settings).toEqual({
      theme: "moonstone",
      hooks: {
        OtherEvent: [{ hooks: [{ type: "command", command: "/existing.sh" }] }],
      },
    });
  });

  it("returns the closest matching resumed session within the resume window", () => {
    mockState.setDir(EVENTS_DIR);
    mockState.writeFile(
      path.join(EVENTS_DIR, "session-old-end.json"),
      JSON.stringify({ event: "end", session_id: "session-old", timestamp: 1000 }),
    );
    mockState.writeFile(
      path.join(EVENTS_DIR, "session-far-start.json"),
      JSON.stringify({ event: "start", session_id: "session-far", timestamp: 7000 }),
    );
    mockState.writeFile(
      path.join(EVENTS_DIR, "session-closest-start.json"),
      JSON.stringify({ event: "start", session_id: "session-closest", timestamp: 1200 }),
    );
    mockState.writeFile(path.join(EVENTS_DIR, "session-bad-start.json"), "{not json");

    expect(readResumeEvent("session-old")).toEqual({ newSessionId: "session-closest" });
  });

  it("returns null when the end event is missing or unreadable", () => {
    expect(readResumeEvent("missing")).toBeNull();

    mockState.writeFile(path.join(EVENTS_DIR, "broken-end.json"), "{not json");
    expect(readResumeEvent("broken")).toBeNull();
  });

  it("removes only stale event files during cleanup", () => {
    vi.spyOn(Date, "now").mockReturnValue(10 * 60 * 1000);
    mockState.setDir(EVENTS_DIR);
    mockState.writeFile(path.join(EVENTS_DIR, "stale.json"), "{}", 1000);
    mockState.writeFile(path.join(EVENTS_DIR, "fresh.json"), "{}", 9 * 60 * 1000);
    mockState.writeFile(path.join(EVENTS_DIR, "ignore.txt"), "{}", 1000);

    cleanupStaleEvents();

    expect(mockState.files.has(path.join(EVENTS_DIR, "stale.json"))).toBe(false);
    expect(mockState.files.has(path.join(EVENTS_DIR, "fresh.json"))).toBe(true);
    expect(mockState.files.has(path.join(EVENTS_DIR, "ignore.txt"))).toBe(true);
  });
});
