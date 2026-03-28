import { describe, expect, it } from "vitest";
import { buildClaudeArgs, buildCopilotArgs, buildStrandsArgs } from "./ClaudeLauncher";

describe("ClaudeLauncher", () => {
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
});
