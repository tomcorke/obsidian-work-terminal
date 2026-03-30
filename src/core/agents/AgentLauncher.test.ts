import { describe, expect, it } from "vitest";
import {
  buildMissingCliNotice,
  buildClaudeArgs,
  buildCopilotArgs,
  buildStrandsArgs,
  mergeExtraArgs,
  parseExtraArgs,
  resolveCommandInfo,
} from "./AgentLauncher";
import { expandTilde } from "../utils";

describe("AgentLauncher", () => {
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

  it("builds Claude args with session id and prompt", () => {
    expect(
      buildClaudeArgs(
        {
          claudeExtraArgs: "--model sonnet",
          additionalAgentContext: "Follow repo rules.",
        },
        "session-123",
        "Review this task",
      ),
    ).toEqual([
      "--model",
      "sonnet",
      "--session-id",
      "session-123",
      "Review this task\n\nFollow repo rules.",
    ]);
  });

  it("builds Copilot args with prompt injection", () => {
    expect(
      buildCopilotArgs(
        {
          copilotExtraArgs: "--model gpt-5.4 --allow-all-tools",
        },
        "Review this task",
      ),
    ).toEqual(["--model", "gpt-5.4", "--allow-all-tools", "-i", "Review this task"]);
  });

  it("builds Copilot args without prompt when launching plain interactive sessions", () => {
    expect(buildCopilotArgs({ copilotExtraArgs: "--model gpt-5.4" })).toEqual([
      "--model",
      "gpt-5.4",
    ]);
  });

  it("builds Copilot args from multiline extra args with continuations", () => {
    expect(
      buildCopilotArgs({
        copilotExtraArgs: `--model gpt-5.4 \\
          --allow-all-tools`,
      }),
    ).toEqual(["--model", "gpt-5.4", "--allow-all-tools"]);
  });

  it("builds Strands args with prompt as positional arg", () => {
    expect(
      buildStrandsArgs({ strandsExtraArgs: "--verbose --region us-east-1" }, "Review this task"),
    ).toEqual(["--verbose", "--region", "us-east-1", "Review this task"]);
  });

  it("builds Strands args without prompt for plain interactive sessions", () => {
    expect(buildStrandsArgs({ strandsExtraArgs: "--verbose" })).toEqual(["--verbose"]);
  });

  it("builds Strands args with no extra args or prompt", () => {
    expect(buildStrandsArgs({})).toEqual([]);
  });

  it("builds Claude args from multiline extra args with continuations", () => {
    expect(
      buildClaudeArgs(
        {
          claudeExtraArgs: `--dangerously-skip-permissions \\
            --plugin-dir /path/a`,
        },
        "session-123",
      ),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "/path/a",
      "--session-id",
      "session-123",
    ]);
  });

  it("reports when a command cannot be resolved", () => {
    expect(resolveCommandInfo("definitely-not-a-real-command-issue-158")).toEqual({
      requested: "definitely-not-a-real-command-issue-158",
      resolved: "definitely-not-a-real-command-issue-158",
      found: false,
    });
  });

  it("treats existing absolute paths as resolved commands", () => {
    expect(resolveCommandInfo("/bin/sh")).toEqual({
      requested: "/bin/sh",
      resolved: "/bin/sh",
      found: true,
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

  it("treats missing relative wrapper paths as unresolved even when cwd is provided", () => {
    expect(resolveCommandInfo("./missing-wrapper", expandTilde("~"))).toEqual({
      requested: "./missing-wrapper",
      resolved: `${expandTilde("~")}/missing-wrapper`,
      found: false,
    });
  });

  it("builds the Claude missing CLI notice", () => {
    expect(buildMissingCliNotice("claude", "claude")).toContain(
      "brew install --cask claude-code",
    );
  });

  it("builds the Copilot missing CLI notice", () => {
    expect(buildMissingCliNotice("copilot", "copilot")).toContain("brew install copilot-cli");
  });
});
