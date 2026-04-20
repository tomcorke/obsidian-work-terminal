/**
 * Tests for resolveNvmDefaultBin() and resolveFnmDefaultBin() with mocked
 * filesystem via electronRequire("fs"). Separated from the main test files
 * because the vi.mock must be at module top level.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Configurable mock filesystem
let mockFs: Record<string, string | true> = {};

function resetMockFs() {
  mockFs = {};
}

/**
 * Set up a mock filesystem. Keys are file paths. Values are file contents
 * (string) or `true` for directories.
 */
function setMockFs(files: Record<string, string | true>) {
  mockFs = { ...files };
}

vi.mock("../utils", async () => {
  const actual = await vi.importActual<typeof import("../utils")>("../utils");
  return {
    ...actual,
    electronRequire: vi.fn((moduleName: string) => {
      if (moduleName === "fs") {
        return {
          existsSync: (p: string) => p in mockFs,
          readFileSync: (p: string, _encoding: string) => {
            if (p in mockFs && typeof mockFs[p] === "string") {
              return mockFs[p];
            }
            const err = new Error(
              `ENOENT: no such file or directory, open '${p}'`,
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          },
          readdirSync: (p: string) => {
            const prefix = p.endsWith("/") ? p : p + "/";
            const entries = new Set<string>();
            for (const key of Object.keys(mockFs)) {
              if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length);
                const firstSegment = rest.split("/")[0];
                if (firstSegment) entries.add(firstSegment);
              }
            }
            return [...entries].sort();
          },
        };
      }
      if (moduleName === "child_process") {
        return {
          spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
        };
      }
      return actual.electronRequire(moduleName);
    }),
  };
});

import {
  resolveNvmDefaultBin,
  resolveFnmDefaultBin,
  getExtraPathDirs,
  _resetLoginShellPathCache,
} from "./AgentLauncher";
import { expandTilde } from "../utils";

afterEach(() => {
  resetMockFs();
  _resetLoginShellPathCache();
});

describe("resolveNvmDefaultBin (mocked fs)", () => {
  const home = expandTilde("~");
  const nvmDir = `${home}/.nvm`;

  it("returns the bin dir for a simple version alias", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "v22.22.0",
      [`${nvmDir}/versions/node/v22.22.0/bin`]: true,
    });

    expect(resolveNvmDefaultBin()).toBe(`${nvmDir}/versions/node/v22.22.0/bin`);
  });

  it("adds v prefix when alias omits it", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "22.22.0",
      [`${nvmDir}/versions/node/v22.22.0/bin`]: true,
    });

    expect(resolveNvmDefaultBin()).toBe(`${nvmDir}/versions/node/v22.22.0/bin`);
  });

  it("follows alias chains (e.g. default -> lts/* -> lts/jod -> v22.22.0)", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "lts/*",
      [`${nvmDir}/alias/lts/*`]: "lts/jod",
      [`${nvmDir}/alias/lts/jod`]: "v22.22.0",
      [`${nvmDir}/versions/node/v22.22.0/bin`]: true,
    });

    expect(resolveNvmDefaultBin()).toBe(`${nvmDir}/versions/node/v22.22.0/bin`);
  });

  it("returns null when nvm is not installed", () => {
    setMockFs({});

    expect(resolveNvmDefaultBin()).toBeNull();
  });

  it("returns null when default alias file is empty", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "",
    });

    expect(resolveNvmDefaultBin()).toBeNull();
  });

  it("returns null when version directory does not exist", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "v99.99.99",
      // No matching version directory
    });

    expect(resolveNvmDefaultBin()).toBeNull();
  });

  it("resolves partial version via directory listing", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "v22",
      [`${nvmDir}/versions/node`]: true,
      [`${nvmDir}/versions/node/v22.21.0/bin`]: true,
      [`${nvmDir}/versions/node/v22.22.0/bin`]: true,
      [`${nvmDir}/versions/node/v20.10.0/bin`]: true,
    });

    // Should match the highest v22.x (reverse-sorted, first match)
    const result = resolveNvmDefaultBin();
    expect(result).toBe(`${nvmDir}/versions/node/v22.22.0/bin`);
  });

  it("resolves partial version using numeric sort (v22.10.0 > v22.9.0)", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "v22",
      [`${nvmDir}/versions/node`]: true,
      [`${nvmDir}/versions/node/v22.9.0/bin`]: true,
      [`${nvmDir}/versions/node/v22.10.0/bin`]: true,
    });

    // Lexicographic sort would pick v22.9.0 (sorts after v22.10.0);
    // numeric-aware sort correctly picks v22.10.0
    const result = resolveNvmDefaultBin();
    expect(result).toBe(`${nvmDir}/versions/node/v22.10.0/bin`);
  });

  it("handles alias chain that leads to empty string gracefully", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "node",
      [`${nvmDir}/alias/node`]: "",
    });

    expect(resolveNvmDefaultBin()).toBeNull();
  });

  it("limits alias chain depth to prevent infinite loops", () => {
    // Create a circular alias chain
    setMockFs({
      [`${nvmDir}/alias/default`]: "a",
      [`${nvmDir}/alias/a`]: "b",
      [`${nvmDir}/alias/b`]: "c",
      [`${nvmDir}/alias/c`]: "d",
      [`${nvmDir}/alias/d`]: "e",
      [`${nvmDir}/alias/e`]: "f", // depth 5, should stop here
      [`${nvmDir}/alias/f`]: "g",
    });

    // Should not infinite loop; version "f" won't match a version dir
    expect(resolveNvmDefaultBin()).toBeNull();
  });
});

describe("resolveFnmDefaultBin (mocked fs)", () => {
  const home = expandTilde("~");
  const fnmDir = `${home}/.local/share/fnm`;

  it("returns the bin dir when fnm aliases/default exists with bin/", () => {
    setMockFs({
      [`${fnmDir}/aliases/default`]: true,
      [`${fnmDir}/aliases/default/bin`]: true,
    });

    expect(resolveFnmDefaultBin()).toBe(`${fnmDir}/aliases/default/bin`);
  });

  it("returns installation/bin when bin/ does not exist", () => {
    setMockFs({
      [`${fnmDir}/aliases/default`]: true,
      [`${fnmDir}/aliases/default/installation/bin`]: true,
    });

    expect(resolveFnmDefaultBin()).toBe(`${fnmDir}/aliases/default/installation/bin`);
  });

  it("returns null when fnm is not installed", () => {
    setMockFs({});

    expect(resolveFnmDefaultBin()).toBeNull();
  });

  it("returns null when aliases/default exists but has no bin directory", () => {
    setMockFs({
      [`${fnmDir}/aliases/default`]: true,
    });

    expect(resolveFnmDefaultBin()).toBeNull();
  });

  it("respects FNM_DIR environment variable", () => {
    const customDir = "/custom/fnm";
    const origFnmDir = process.env.FNM_DIR;
    process.env.FNM_DIR = customDir;
    try {
      setMockFs({
        [`${customDir}/aliases/default`]: true,
        [`${customDir}/aliases/default/bin`]: true,
      });

      expect(resolveFnmDefaultBin()).toBe(`${customDir}/aliases/default/bin`);
    } finally {
      if (origFnmDir === undefined) delete process.env.FNM_DIR;
      else process.env.FNM_DIR = origFnmDir;
    }
  });

  it("respects XDG_DATA_HOME environment variable", () => {
    const xdgDir = "/custom/xdg-data";
    const origXdg = process.env.XDG_DATA_HOME;
    const origFnm = process.env.FNM_DIR;
    delete process.env.FNM_DIR;
    process.env.XDG_DATA_HOME = xdgDir;
    try {
      setMockFs({
        [`${xdgDir}/fnm/aliases/default`]: true,
        [`${xdgDir}/fnm/aliases/default/bin`]: true,
      });

      expect(resolveFnmDefaultBin()).toBe(`${xdgDir}/fnm/aliases/default/bin`);
    } finally {
      if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdg;
      if (origFnm === undefined) delete process.env.FNM_DIR;
      else process.env.FNM_DIR = origFnm;
    }
  });

  it("prefers FNM_DIR over XDG_DATA_HOME", () => {
    const fnmDirPath = "/custom/fnm";
    const xdgDir = "/custom/xdg-data";
    const origFnm = process.env.FNM_DIR;
    const origXdg = process.env.XDG_DATA_HOME;
    process.env.FNM_DIR = fnmDirPath;
    process.env.XDG_DATA_HOME = xdgDir;
    try {
      setMockFs({
        [`${fnmDirPath}/aliases/default`]: true,
        [`${fnmDirPath}/aliases/default/bin`]: true,
        [`${xdgDir}/fnm/aliases/default`]: true,
        [`${xdgDir}/fnm/aliases/default/bin`]: true,
      });

      // FNM_DIR takes precedence
      expect(resolveFnmDefaultBin()).toBe(`${fnmDirPath}/aliases/default/bin`);
    } finally {
      if (origFnm === undefined) delete process.env.FNM_DIR;
      else process.env.FNM_DIR = origFnm;
      if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdg;
    }
  });
});

describe("getExtraPathDirs with mocked nvm/fnm", () => {
  const home = expandTilde("~");
  const nvmDir = `${home}/.nvm`;
  const fnmDir = `${home}/.local/share/fnm`;

  it("includes resolved nvm bin dir on Unix", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "v22.22.0",
      [`${nvmDir}/versions/node/v22.22.0/bin`]: true,
    });

    const dirs = getExtraPathDirs("darwin", {} as NodeJS.ProcessEnv);
    expect(dirs).toContain(`${nvmDir}/versions/node/v22.22.0/bin`);
  });

  it("includes resolved fnm bin dir on Unix", () => {
    setMockFs({
      [`${fnmDir}/aliases/default`]: true,
      [`${fnmDir}/aliases/default/bin`]: true,
    });

    const dirs = getExtraPathDirs("linux", {} as NodeJS.ProcessEnv);
    expect(dirs).toContain(`${fnmDir}/aliases/default/bin`);
  });

  it("does not include nvm/fnm dirs on Windows", () => {
    setMockFs({
      [`${nvmDir}/alias/default`]: "v22.22.0",
      [`${nvmDir}/versions/node/v22.22.0/bin`]: true,
    });

    const dirs = getExtraPathDirs("win32", {} as NodeJS.ProcessEnv);
    const hasNvmPath = dirs.some((d) => d.includes(".nvm"));
    // Windows uses its own nvm-windows path pattern, not Unix nvm
    expect(hasNvmPath).toBe(false);
  });

  it("still includes static dirs when nvm/fnm are not installed", () => {
    setMockFs({});

    const dirs = getExtraPathDirs("darwin", {} as NodeJS.ProcessEnv);
    expect(dirs).toContain(expandTilde("~/.local/bin"));
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });
});
