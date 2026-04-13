import { describe, expect, it } from "vitest";
import { spawnHeadlessClaude } from "./HeadlessClaude";

describe("HeadlessClaude", () => {
  it("returns install guidance when the Claude CLI is unavailable", async () => {
    await expect(
      spawnHeadlessClaude(
        "Review this task",
        process.cwd(),
        "definitely-not-a-real-command-issue-158",
      ),
    ).resolves.toEqual({
      exitCode: -1,
      stdout: "",
      stderr:
        'Claude Code CLI not found for "definitely-not-a-real-command-issue-158". Install it first, for example with brew install --cask claude-code, then update Work Terminal\'s Claude command setting if needed.',
      missingCli: true,
    });
  });

  it("does not treat a missing relative wrapper path as available", async () => {
    await expect(
      spawnHeadlessClaude("Review this task", process.cwd(), "./missing-claude-wrapper"),
    ).resolves.toEqual({
      exitCode: -1,
      stdout: "",
      stderr:
        'Claude Code CLI not found for "./missing-claude-wrapper". Install it first, for example with brew install --cask claude-code, then update Work Terminal\'s Claude command setting if needed.',
      missingCli: true,
    });
  });
});
