import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildCopilotArgs,
  buildStrandsArgs,
  mergeExtraArgs,
  parseExtraArgs,
} from "./AgentLauncher";

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
});
