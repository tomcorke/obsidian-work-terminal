import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentArgs,
  buildMissingCliNotice,
  mergeExtraArgs,
  parseExtraArgs,
  resolveCommand,
  resolveCommandInfo,
  _resetLoginShellPathCache,
} from "./AgentLauncher";
import { expandTilde } from "../utils";

describe("AgentLauncher", () => {
  const originalPath = process.env.PATH;
  const originalPathext = process.env.PATHEXT;

  beforeEach(() => {
    _resetLoginShellPathCache();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathext;
    _resetLoginShellPathCache();
  });

  it("parses backslash-newline continuations without keeping continuation tokens", () => {
    expect(
      parseExtraArgs(`--dangerously-skip-permissions \\
        --plugin-dir /path/a \\
        --plugin-dir /path/b`),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "/path/a",
      "--plugin-dir",
      "/path/b",
    ]);
  });

  it("merges multiline extra args without leaving continuation tokens behind", () => {
    expect(
      mergeExtraArgs(
        `--dangerously-skip-permissions \\
          --plugin-dir /path/a`,
        `--plugin-dir /path/b \\
          --verbose`,
      ),
    ).toBe("--dangerously-skip-permissions --plugin-dir /path/a --plugin-dir /path/b --verbose");
  });

  // ---- buildAgentArgs (unified) ----

  it("builds agent args for claude with positional prompt injection", () => {
    expect(buildAgentArgs("claude", "--model sonnet", "Review this task")).toEqual([
      "--model",
      "sonnet",
      "Review this task",
    ]);
  });

  it("builds agent args for copilot with flag-based prompt injection", () => {
    expect(
      buildAgentArgs("copilot", "--model gpt-5.4 --allow-all-tools", "Review this task"),
    ).toEqual(["--model", "gpt-5.4", "--allow-all-tools", "-i", "Review this task"]);
  });

  it("builds agent args for strands with positional prompt injection", () => {
    expect(buildAgentArgs("strands", "--verbose --region us-east-1", "Review this task")).toEqual([
      "--verbose",
      "--region",
      "us-east-1",
      "Review this task",
    ]);
  });

  it("builds agent args with no prompt", () => {
    expect(buildAgentArgs("claude", "--model sonnet")).toEqual(["--model", "sonnet"]);
  });

  it("builds agent args with no extra args or prompt", () => {
    expect(buildAgentArgs("strands")).toEqual([]);
  });

  it("appends additionalAgentContext to prompt for all agent types", () => {
    expect(buildAgentArgs("claude", undefined, "Review this task", "Follow repo rules.")).toEqual([
      "Review this task\n\nFollow repo rules.",
    ]);

    expect(buildAgentArgs("copilot", undefined, "Review this task", "Follow repo rules.")).toEqual([
      "-i",
      "Review this task\n\nFollow repo rules.",
    ]);

    expect(buildAgentArgs("strands", undefined, "Review this task", "Follow repo rules.")).toEqual([
      "Review this task\n\nFollow repo rules.",
    ]);
  });

  it("ignores additionalAgentContext when no prompt is provided", () => {
    expect(buildAgentArgs("claude", "--model sonnet", undefined, "Follow repo rules.")).toEqual([
      "--model",
      "sonnet",
    ]);
  });

  it("reports found status for commands discovered on PATH", () => {
    const path = require("path") as typeof import("path");
    process.env.PATH = path.dirname(process.execPath);

    const resolution = resolveCommandInfo(path.basename(process.execPath));

    expect(resolution.found).toBe(true);
    expect(path.basename(resolution.resolved)).toBe(path.basename(process.execPath));
    expect(resolveCommand(path.basename(process.execPath))).toBe(resolution.resolved);
  });

  it("reports found status for absolute paths", () => {
    const resolution = resolveCommandInfo(process.execPath);

    expect(resolution).toEqual({
      requested: process.execPath,
      resolved: process.execPath,
      found: true,
    });
  });

  it("reports when a command cannot be resolved", () => {
    expect(resolveCommandInfo("definitely-not-a-real-command-issue-158")).toEqual({
      requested: "definitely-not-a-real-command-issue-158",
      resolved: "definitely-not-a-real-command-issue-158",
      found: false,
    });
  });

  it("treats slash-containing relative paths as unresolved when no launch cwd is known", () => {
    expect(resolveCommandInfo("./bin/claude-wrapper")).toEqual({
      requested: "./bin/claude-wrapper",
      resolved: "./bin/claude-wrapper",
      found: false,
    });
  });

  it("resolves relative wrapper paths against the launch cwd", () => {
    expect(resolveCommandInfo("./sh", "/bin")).toEqual({
      requested: "./sh",
      resolved: "/bin/sh",
      found: true,
    });
  });

  it("treats malformed absolute paths as unresolved instead of throwing", () => {
    expect(resolveCommandInfo("/bin/\u0000bad-command")).toEqual({
      requested: "/bin/\u0000bad-command",
      resolved: "/bin/\u0000bad-command",
      found: false,
    });
  });

  it("resolves executable relative paths from the provided cwd", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const scriptPath = path.join(process.cwd(), "issue-160-launchable-test.sh");
    try {
      fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(scriptPath, 0o755);
      const executablePath = "./issue-160-launchable-test.sh";
      const resolution = resolveCommandInfo(executablePath, process.cwd());

      expect(resolution.resolved).toBe(path.resolve(process.cwd(), executablePath));
      expect(resolution.found).toBe(true);
    } finally {
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore cleanup failures */
      }
    }
  });

  it("reports non-executable relative paths as not found", () => {
    const resolution = resolveCommandInfo("./package.json", process.cwd());

    expect(resolution.resolved).toBe(require("path").resolve(process.cwd(), "./package.json"));
    expect(resolution.found).toBe(false);
  });

  it("treats missing relative wrapper paths as unresolved even when cwd is provided", () => {
    expect(resolveCommandInfo("./missing-wrapper", expandTilde("~"))).toEqual({
      requested: "./missing-wrapper",
      resolved: `${expandTilde("~")}/missing-wrapper`,
      found: false,
    });
  });

  it("reports missing commands without changing the requested command", () => {
    const missing = "definitely-not-a-real-command-issue-160";
    const resolution = resolveCommandInfo(missing);

    expect(resolution).toEqual({
      requested: missing,
      resolved: missing,
      found: false,
    });
    expect(resolveCommand(missing)).toBe(missing);
  });

  it("resolves Windows drive-letter paths as executable commands", () => {
    const path = require("path") as typeof import("path");
    const fs = {
      statSync: (target: string) => {
        if (target === "C:\\Tools\\claude.exe") {
          return { isDirectory: () => false };
        }
        throw new Error(`Unexpected statSync path: ${target}`);
      },
      accessSync: () => undefined,
      constants: { X_OK: 0 },
    } as unknown as typeof import("fs");
    const resolution = resolveCommandInfo("C:\\Tools\\claude.exe", undefined, {
      fs,
      pathModule: path,
      platform: "win32",
      env: { ...process.env, PATHEXT: ".EXE;.CMD" },
    });

    expect(resolution).toEqual({
      requested: "C:\\Tools\\claude.exe",
      resolved: "C:\\Tools\\claude.exe",
      found: true,
    });
  });

  it("resolves Windows UNC paths as executable commands", () => {
    const path = require("path") as typeof import("path");
    const fs = {
      statSync: (target: string) => {
        if (target === "\\\\server\\share\\copilot.cmd") {
          return { isDirectory: () => false };
        }
        throw new Error(`Unexpected statSync path: ${target}`);
      },
      accessSync: () => undefined,
      constants: { X_OK: 0 },
    } as unknown as typeof import("fs");
    const resolution = resolveCommandInfo("\\\\server\\share\\copilot.cmd", undefined, {
      fs,
      pathModule: path,
      platform: "win32",
      env: { ...process.env, PATHEXT: ".EXE;.CMD" },
    });

    expect(resolution).toEqual({
      requested: "\\\\server\\share\\copilot.cmd",
      resolved: "\\\\server\\share\\copilot.cmd",
      found: true,
    });
  });

  it("resolves Windows backslash-relative paths from the provided cwd", () => {
    const path = require("path") as typeof import("path");
    const resolvedPath = "C:\\repo\\agent.cmd";
    const fs = {
      statSync: (target: string) => {
        if (target === resolvedPath) {
          return { isDirectory: () => false };
        }
        throw new Error(`Unexpected statSync path: ${target}`);
      },
      accessSync: () => undefined,
      constants: { X_OK: 0 },
    } as unknown as typeof import("fs");
    const resolution = resolveCommandInfo(".\\agent.cmd", "C:\\repo", {
      fs,
      pathModule: path,
      platform: "win32",
      env: { ...process.env, PATHEXT: ".EXE;.CMD" },
    });

    expect(resolution).toEqual({
      requested: ".\\agent.cmd",
      resolved: resolvedPath,
      found: true,
    });
  });

  it("treats existing non-executable Windows files as not found", () => {
    const path = require("path") as typeof import("path");
    const fs = {
      statSync: (target: string) => {
        if (target === "C:\\repo\\package.json") {
          return { isDirectory: () => false };
        }
        throw new Error(`Unexpected statSync path: ${target}`);
      },
      accessSync: () => undefined,
      constants: { X_OK: 0 },
    } as unknown as typeof import("fs");
    const resolution = resolveCommandInfo("C:\\repo\\package.json", undefined, {
      fs,
      pathModule: path,
      platform: "win32",
      env: { ...process.env, PATHEXT: ".EXE;.CMD" },
    });

    expect(resolution).toEqual({
      requested: "C:\\repo\\package.json",
      resolved: "C:\\repo\\package.json",
      found: false,
    });
  });

  it("searches Windows PATH entries with the platform delimiter and PATHEXT", () => {
    const path = require("path") as typeof import("path");
    const fs = {
      statSync: (target: string) => {
        if (target === "C:\\Tools\\copilot.exe") {
          return { isDirectory: () => false };
        }
        throw new Error(`Unexpected statSync path: ${target}`);
      },
      accessSync: () => undefined,
      constants: { X_OK: 0 },
    } as unknown as typeof import("fs");
    const resolution = resolveCommandInfo("copilot", undefined, {
      fs,
      pathModule: path,
      platform: "win32",
      env: {
        ...process.env,
        PATH: "C:\\Tools;C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD",
      },
    });

    expect(resolution).toEqual({
      requested: "copilot",
      resolved: "C:\\Tools\\copilot.exe",
      found: true,
    });
  });

  it("builds the Claude missing CLI notice", () => {
    expect(buildMissingCliNotice("claude", "claude")).toContain("brew install --cask claude-code");
  });

  it("builds the Copilot missing CLI notice", () => {
    expect(buildMissingCliNotice("copilot", "copilot")).toContain("brew install copilot-cli");
  });
});
