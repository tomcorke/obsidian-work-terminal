import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../core/agents/AgentProfile";
import {
  LAST_CLAUDE_PROFILE_DELETE_REASON,
  buildLastClaudeDeleteGuard,
} from "./AgentProfileManagerModal";

function makeProfile(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    agentType: overrides.agentType ?? "claude",
    command: overrides.command ?? "",
    defaultCwd: overrides.defaultCwd ?? "",
    arguments: overrides.arguments ?? "",
    contextPrompt: overrides.contextPrompt ?? "",
    useContext: overrides.useContext ?? false,
    suppressAdapterPrompt: overrides.suppressAdapterPrompt ?? false,
    button: overrides.button ?? { enabled: false, label: overrides.name ?? overrides.id },
    sortOrder: overrides.sortOrder ?? 0,
  };
}

describe("buildLastClaudeDeleteGuard", () => {
  const claudeCtx = makeProfile({
    id: "default-claude-ctx",
    name: "Claude (ctx)",
    useContext: true,
  });
  const claude = makeProfile({ id: "default-claude", name: "Claude" });
  const customClaude = makeProfile({ id: "custom-claude", name: "My Claude" });
  const shellProfile = makeProfile({ id: "shell", name: "Shell", agentType: "shell" });
  const copilotProfile = makeProfile({
    id: "copilot",
    name: "Copilot",
    agentType: "copilot",
  });

  it("blocks deleting the only Claude profile", () => {
    const guard = buildLastClaudeDeleteGuard([claudeCtx, shellProfile]);
    const reason = guard(claudeCtx);
    expect(reason).toBe(LAST_CLAUDE_PROFILE_DELETE_REASON);
  });

  it("blocks deleting the only Claude profile even when non-Claude profiles exist", () => {
    const guard = buildLastClaudeDeleteGuard([claudeCtx, shellProfile, copilotProfile]);
    expect(guard(claudeCtx)).toBe(LAST_CLAUDE_PROFILE_DELETE_REASON);
  });

  it("allows deleting a Claude profile when another Claude profile remains", () => {
    const guard = buildLastClaudeDeleteGuard([claudeCtx, claude, shellProfile]);
    expect(guard(claudeCtx)).toBeNull();
    expect(guard(claude)).toBeNull();
  });

  it("allows deleting a custom Claude profile when built-in Claude profiles remain", () => {
    const guard = buildLastClaudeDeleteGuard([claudeCtx, claude, customClaude]);
    expect(guard(customClaude)).toBeNull();
  });

  it("always allows deleting non-Claude profiles, even when only one Claude profile exists", () => {
    const guard = buildLastClaudeDeleteGuard([claudeCtx, shellProfile, copilotProfile]);
    expect(guard(shellProfile)).toBeNull();
    expect(guard(copilotProfile)).toBeNull();
  });

  it("allows deleting non-Claude profiles when zero Claude profiles exist", () => {
    // Shouldn't arise in practice because the guard prevents reaching this
    // state, but confirm the guard does not misclassify shell/copilot as the
    // "last Claude" profile.
    const guard = buildLastClaudeDeleteGuard([shellProfile, copilotProfile]);
    expect(guard(shellProfile)).toBeNull();
    expect(guard(copilotProfile)).toBeNull();
  });

  it("treats agentType 'claude' as the Claude family regardless of profile id", () => {
    // Custom-id Claude profiles should still count towards the minimum -
    // the guard must not rely on the built-in default-* ids.
    const onlyCustomClaude = makeProfile({
      id: "my-own-claude",
      name: "My Own Claude",
      agentType: "claude",
    });
    const guard = buildLastClaudeDeleteGuard([onlyCustomClaude, shellProfile]);
    expect(guard(onlyCustomClaude)).toBe(LAST_CLAUDE_PROFILE_DELETE_REASON);
  });
});
