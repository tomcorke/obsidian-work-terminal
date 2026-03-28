import { describe, expect, it } from "vitest";
import {
  createDefaultCustomSessionConfig,
  getDefaultSessionLabel,
  getSessionTypeHelp,
  isClaudeSession,
  isContextSession,
  isCopilotSession,
  isStrandsSession,
  sanitizeCustomSessionConfig,
  supportsExtraArgs,
} from "./CustomSessionConfig";

describe("CustomSessionConfig", () => {
  it("creates Claude defaults using the provided cwd", () => {
    expect(createDefaultCustomSessionConfig("~/work")).toEqual({
      sessionType: "claude",
      cwd: "~/work",
      extraArgs: "",
      label: "",
    });
  });

  it("sanitizes partial saved config", () => {
    expect(
      sanitizeCustomSessionConfig(
        {
          sessionType: "copilot-with-context",
          cwd: "  ~/repo  ",
          extraArgs: "  --model gpt-5.4  ",
          label: "  Pairing  ",
        },
        "~",
      ),
    ).toEqual({
      sessionType: "copilot-with-context",
      cwd: "~/repo",
      extraArgs: "--model gpt-5.4",
      label: "Pairing",
    });
  });

  it("falls back to Claude and default cwd for invalid saved config", () => {
    expect(
      sanitizeCustomSessionConfig(
        {
          sessionType: "not-real" as never,
          cwd: "   ",
        },
        "~/default",
      ),
    ).toEqual({
      sessionType: "claude",
      cwd: "~/default",
      extraArgs: "",
      label: "",
    });
  });

  it("provides default labels for built-in session types", () => {
    expect(getDefaultSessionLabel("shell")).toBe("Shell");
    expect(getDefaultSessionLabel("claude")).toBe("Claude");
    expect(getDefaultSessionLabel("claude-with-context")).toBe("Claude (ctx)");
    expect(getDefaultSessionLabel("copilot")).toBe("Copilot");
    expect(getDefaultSessionLabel("copilot-with-context")).toBe("Copilot (ctx)");
    expect(getDefaultSessionLabel("strands")).toBe("Strands");
    expect(getDefaultSessionLabel("strands-with-context")).toBe("Strands (ctx)");
  });

  it("describes session resume behavior per session type", () => {
    expect(getSessionTypeHelp("shell")).toContain("not saved for restart resume");
    expect(getSessionTypeHelp("claude")).toContain("--session-id");
    expect(getSessionTypeHelp("claude")).toContain("Claude hooks");
    expect(getSessionTypeHelp("copilot")).toContain("--resume[=sessionId]");
    expect(getSessionTypeHelp("copilot")).toContain("without Claude hooks");
    expect(getSessionTypeHelp("strands")).toContain("start fresh each time");
  });

  it("identifies context and copilot sessions", () => {
    expect(isContextSession("claude-with-context")).toBe(true);
    expect(isContextSession("copilot-with-context")).toBe(true);
    expect(isContextSession("strands-with-context")).toBe(true);
    expect(isContextSession("copilot")).toBe(false);
    expect(isContextSession("strands")).toBe(false);
    expect(isClaudeSession("claude")).toBe(true);
    expect(isClaudeSession("claude-with-context")).toBe(true);
    expect(isClaudeSession("copilot")).toBe(false);
    expect(isCopilotSession("copilot")).toBe(true);
    expect(isCopilotSession("copilot-with-context")).toBe(true);
    expect(isCopilotSession("claude")).toBe(false);
  });

  it("only allows extra args for non-shell sessions", () => {
    expect(supportsExtraArgs("shell")).toBe(false);
    expect(supportsExtraArgs("claude")).toBe(true);
    expect(supportsExtraArgs("copilot")).toBe(true);
    expect(supportsExtraArgs("strands")).toBe(true);
  });

  it("identifies strands sessions", () => {
    expect(isStrandsSession("strands")).toBe(true);
    expect(isStrandsSession("strands-with-context")).toBe(true);
    expect(isStrandsSession("copilot")).toBe(false);
    expect(isStrandsSession("claude")).toBe(false);
  });
});
