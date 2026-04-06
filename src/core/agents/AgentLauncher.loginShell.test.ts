/**
 * Tests for resolveLoginShellPath() and getFullPath() that require mocking
 * electronRequire("child_process"). Separated from AgentLauncher.test.ts
 * because vi.mock must be at module top level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Configurable spawnSync response for each test
let mockSpawnSyncResult: {
  status: number | null;
  stdout: string;
  stderr: string;
} = { status: 0, stdout: "", stderr: "" };

// Track spawnSync calls for assertion
let spawnSyncCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> =
  [];

vi.mock("../utils", async () => {
  const actual = await vi.importActual<typeof import("../utils")>("../utils");
  return {
    ...actual,
    electronRequire: vi.fn((moduleName: string) => {
      if (moduleName === "child_process") {
        return {
          spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) => {
            spawnSyncCalls.push({ command: cmd, args, options: opts });
            return mockSpawnSyncResult;
          },
        };
      }
      return actual.electronRequire(moduleName);
    }),
  };
});

// Import after mock setup
import {
  resolveLoginShellPath,
  getFullPath,
  getExtraPathDirs,
  _resetLoginShellPathCache,
} from "./AgentLauncher";
import { expandTilde } from "../utils";

describe("resolveLoginShellPath (mocked)", () => {
  beforeEach(() => {
    _resetLoginShellPathCache();
    spawnSyncCalls = [];
    mockSpawnSyncResult = { status: 0, stdout: "", stderr: "" };
  });

  afterEach(() => {
    _resetLoginShellPathCache();
  });

  it("extracts PATH from between sentinels", () => {
    const expectedPath = "/usr/local/bin:/usr/bin:/bin:/home/user/.nvm/bin";
    mockSpawnSyncResult = {
      status: 0,
      stdout: `___PATH_START___${expectedPath}___PATH_END___`,
      stderr: "",
    };

    const result = resolveLoginShellPath();
    expect(result).toBe(expectedPath);
  });

  it("falls back to raw stdout when sentinels are missing", () => {
    const rawPath = "/usr/local/bin:/usr/bin:/bin";
    mockSpawnSyncResult = {
      status: 0,
      stdout: rawPath,
      stderr: "",
    };

    const result = resolveLoginShellPath();
    expect(result).toBe(rawPath);
  });

  it("strips shell greeting noise when sentinels are present", () => {
    const expectedPath = "/usr/bin:/bin";
    mockSpawnSyncResult = {
      status: 0,
      stdout: `Last login: Mon Apr 1 10:00:00\nWelcome to zsh\n___PATH_START___${expectedPath}___PATH_END___`,
      stderr: "",
    };

    const result = resolveLoginShellPath();
    expect(result).toBe(expectedPath);
  });

  it("returns null when the shell process fails", () => {
    mockSpawnSyncResult = {
      status: 1,
      stdout: "",
      stderr: "shell error",
    };

    const result = resolveLoginShellPath();
    expect(result).toBeNull();
  });

  it("returns null when spawnSync throws", async () => {
    mockSpawnSyncResult = {
      status: 0,
      stdout: "",
      stderr: "",
    };
    // Override to throw
    const utils = vi.mocked(await import("../utils"));
    utils.electronRequire.mockImplementationOnce((moduleName: string) => {
      if (moduleName === "child_process") {
        return {
          spawnSync: () => {
            throw new Error("spawn failed");
          },
        };
      }
      return require(moduleName);
    });

    const result = resolveLoginShellPath();
    expect(result).toBeNull();
  });

  it("passes TERM=dumb in the spawn environment", () => {
    mockSpawnSyncResult = {
      status: 0,
      stdout: "___PATH_START___/usr/bin___PATH_END___",
      stderr: "",
    };

    resolveLoginShellPath();

    expect(spawnSyncCalls.length).toBe(1);
    const env = spawnSyncCalls[0].options.env as Record<string, string>;
    expect(env.TERM).toBe("dumb");
  });

  it("uses sentinel markers in the shell command", () => {
    mockSpawnSyncResult = {
      status: 0,
      stdout: "___PATH_START___/usr/bin___PATH_END___",
      stderr: "",
    };

    resolveLoginShellPath();

    expect(spawnSyncCalls.length).toBe(1);
    const shellArgs = spawnSyncCalls[0].args;
    // The printf command should include sentinels
    expect(shellArgs.some((arg: string) => arg.includes("___PATH_START___"))).toBe(true);
    expect(shellArgs.some((arg: string) => arg.includes("___PATH_END___"))).toBe(true);
  });

  it("caches the result and does not re-spawn", () => {
    mockSpawnSyncResult = {
      status: 0,
      stdout: "___PATH_START___/cached/path___PATH_END___",
      stderr: "",
    };

    const first = resolveLoginShellPath();
    const second = resolveLoginShellPath();

    expect(first).toBe("/cached/path");
    expect(second).toBe("/cached/path");
    expect(spawnSyncCalls.length).toBe(1); // Only one spawn
  });
});

describe("getFullPath (mocked)", () => {
  const path = require("path") as typeof import("path");

  beforeEach(() => {
    _resetLoginShellPathCache();
    spawnSyncCalls = [];
  });

  afterEach(() => {
    _resetLoginShellPathCache();
  });

  it("merges login shell PATH, EXTRA_PATH_DIRS, and env.PATH with deduplication", () => {
    mockSpawnSyncResult = {
      status: 0,
      stdout: "___PATH_START___/login/bin:/usr/bin___PATH_END___",
      stderr: "",
    };

    const env = { PATH: "/env/bin:/usr/bin" } as NodeJS.ProcessEnv;
    const result = getFullPath(env, path, "linux");
    const dirs = result.split(":");

    // Platform-appropriate EXTRA_PATH_DIRS come first
    for (const extraDir of getExtraPathDirs("linux", env)) {
      expect(dirs).toContain(extraDir);
    }

    // Login shell dirs
    expect(dirs).toContain("/login/bin");

    // env.PATH dirs
    expect(dirs).toContain("/env/bin");

    // /usr/bin appears in both login and env, should only appear once
    const usrBinCount = dirs.filter((d) => d === "/usr/bin").length;
    expect(usrBinCount).toBe(1);

    // No duplicates overall
    expect(dirs.length).toBe(new Set(dirs).size);
  });

  it("works when login shell returns null (falls back to env.PATH only)", () => {
    mockSpawnSyncResult = {
      status: 1,
      stdout: "",
      stderr: "error",
    };

    const result = getFullPath(
      { PATH: "/fallback/bin:/usr/bin" } as NodeJS.ProcessEnv,
      path,
      "linux",
    );
    const dirs = result.split(":");

    // Platform extra path dirs still present
    expect(dirs).toContain(expandTilde("~/.local/bin"));
    // env.PATH entries present
    expect(dirs).toContain("/fallback/bin");
    expect(dirs).toContain("/usr/bin");
  });

  it("uses POSIX fallback PATH when env.PATH is undefined", () => {
    mockSpawnSyncResult = {
      status: 1,
      stdout: "",
      stderr: "",
    };

    const result = getFullPath({} as NodeJS.ProcessEnv, path, "linux");
    const dirs = result.split(":");

    // Fallback: /usr/local/bin:/usr/bin:/bin
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/usr/bin");
    expect(dirs).toContain("/bin");
  });

  it("uses semicolon delimiter and Windows dirs on win32", () => {
    mockSpawnSyncResult = {
      status: 1,
      stdout: "",
      stderr: "",
    };

    const env = {
      PATH: "C:\\Windows\\System32",
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
      ProgramFiles: "C:\\Program Files",
    } as unknown as NodeJS.ProcessEnv;

    const result = getFullPath(env, path, "win32");

    // Must use semicolon delimiter (Windows convention)
    expect(result).toContain(";");
    expect(result).not.toMatch(/(?<![A-Za-z]):/);

    const dirs = result.split(";");

    // Windows extra dirs are present (expanded)
    expect(dirs).toContain("C:\\Users\\Test\\AppData\\Local\\Programs\\node");
    expect(dirs).toContain("C:\\Users\\Test\\AppData\\Roaming\\nvm");
    expect(dirs).toContain("C:\\Program Files\\nodejs");

    // env.PATH entry is present
    expect(dirs).toContain("C:\\Windows\\System32");

    // Unix dirs must NOT be present
    const hasUnixPaths = dirs.some((d) => d.includes("/usr/") || d.includes("/opt/"));
    expect(hasUnixPaths).toBe(false);
  });
});

describe("getExtraPathDirs (platform-aware)", () => {
  it("returns Unix paths for darwin", () => {
    const dirs = getExtraPathDirs("darwin", {} as NodeJS.ProcessEnv);
    expect(dirs).toContain(expandTilde("~/.local/bin"));
    expect(dirs).toContain(expandTilde("~/.nvm/versions/node/current/bin"));
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });

  it("returns Unix paths for linux", () => {
    const dirs = getExtraPathDirs("linux", {} as NodeJS.ProcessEnv);
    expect(dirs).toContain(expandTilde("~/.local/bin"));
    expect(dirs).toContain("/usr/local/bin");
  });

  it("returns Windows paths for win32 with env var expansion", () => {
    const env = {
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
      ProgramFiles: "C:\\Program Files",
    } as unknown as NodeJS.ProcessEnv;

    const dirs = getExtraPathDirs("win32", env);
    expect(dirs).toContain("C:\\Users\\Test\\AppData\\Local\\Programs\\node");
    expect(dirs).toContain("C:\\Users\\Test\\AppData\\Roaming\\nvm");
    expect(dirs).toContain("C:\\Users\\Test\\AppData\\Local\\Microsoft\\WinGet\\Links");
    expect(dirs).toContain("C:\\Program Files\\nodejs");
  });

  it("preserves unexpanded env vars when variables are missing on Windows", () => {
    const dirs = getExtraPathDirs("win32", {} as NodeJS.ProcessEnv);
    // When env vars are undefined, the %VAR% placeholder is preserved as-is
    expect(dirs).toContain("%LOCALAPPDATA%\\Programs\\node");
  });

  it("does not include Unix paths for win32", () => {
    const dirs = getExtraPathDirs("win32", {} as NodeJS.ProcessEnv);
    const hasUnixPaths = dirs.some((d) => d.includes("/usr/") || d.includes("/opt/"));
    expect(hasUnixPaths).toBe(false);
  });

  it("does not include Windows paths for darwin", () => {
    const dirs = getExtraPathDirs("darwin", {} as NodeJS.ProcessEnv);
    const hasWindowsPaths = dirs.some((d) => d.includes("LOCALAPPDATA") || d.includes("APPDATA"));
    expect(hasWindowsPaths).toBe(false);
  });
});
