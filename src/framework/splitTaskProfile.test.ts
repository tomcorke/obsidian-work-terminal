import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { resolveRetryEnrichmentProfile, resolveSplitTaskProfile } from "./splitTaskProfile";

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

const claudeCtx = makeProfile({ id: "default-claude-ctx", name: "Claude (ctx)", useContext: true });
const claude = makeProfile({ id: "default-claude", name: "Claude" });
const custom = makeProfile({
  id: "custom-123",
  name: "Custom",
  defaultCwd: "/repos/app",
});

describe("resolveSplitTaskProfile", () => {
  it("returns the configured profile when it exists", () => {
    const profile = resolveSplitTaskProfile({ "adapter.splitTaskProfile": "custom-123" }, [
      claudeCtx,
      claude,
      custom,
    ]);
    expect(profile?.id).toBe("custom-123");
  });

  it("falls back to default-claude-ctx when setting is empty", () => {
    const profile = resolveSplitTaskProfile({}, [claude, claudeCtx]);
    expect(profile?.id).toBe("default-claude-ctx");
  });

  it("falls back to default-claude-ctx when configured profile no longer exists", () => {
    const profile = resolveSplitTaskProfile({ "adapter.splitTaskProfile": "vanished" }, [
      claudeCtx,
      claude,
    ]);
    expect(profile?.id).toBe("default-claude-ctx");
  });

  it("falls back to default-claude when ctx variant is missing", () => {
    const profile = resolveSplitTaskProfile({}, [claude]);
    expect(profile?.id).toBe("default-claude");
  });

  it("returns any claude profile as the last fallback", () => {
    const other = makeProfile({ id: "other-claude", agentType: "claude" });
    const profile = resolveSplitTaskProfile({}, [other]);
    expect(profile?.id).toBe("other-claude");
  });

  it("returns null when no claude profile exists", () => {
    const shell = makeProfile({ id: "shell-only", agentType: "shell" });
    expect(resolveSplitTaskProfile({}, [shell])).toBeNull();
    expect(resolveSplitTaskProfile({}, [])).toBeNull();
  });

  it("rejects a configured non-claude profile and falls back to defaults", () => {
    const shell = makeProfile({ id: "my-shell", agentType: "shell" });
    const profile = resolveSplitTaskProfile({ "adapter.splitTaskProfile": "my-shell" }, [
      shell,
      claudeCtx,
      claude,
    ]);
    expect(profile?.id).toBe("default-claude-ctx");
  });

  it("rejects a non-claude default-claude-ctx and continues the fallback chain", () => {
    const notClaude = makeProfile({ id: "default-claude-ctx", agentType: "shell" });
    const profile = resolveSplitTaskProfile({}, [notClaude, claude]);
    expect(profile?.id).toBe("default-claude");
  });

  it("rejects a non-claude last-resort fallback", () => {
    const copilot = makeProfile({ id: "default-copilot", agentType: "copilot" });
    expect(resolveSplitTaskProfile({}, [copilot])).toBeNull();
  });
});

describe("resolveRetryEnrichmentProfile", () => {
  it("prefers adapter.retryEnrichmentProfile", () => {
    const profile = resolveRetryEnrichmentProfile(
      {
        "adapter.retryEnrichmentProfile": "custom-123",
        "adapter.enrichmentProfile": "default-claude",
      },
      [claude, claudeCtx, custom],
    );
    expect(profile?.id).toBe("custom-123");
  });

  it("falls back to adapter.enrichmentProfile when retry-specific key is empty", () => {
    const profile = resolveRetryEnrichmentProfile({ "adapter.enrichmentProfile": "custom-123" }, [
      claude,
      claudeCtx,
      custom,
    ]);
    expect(profile?.id).toBe("custom-123");
  });

  it("falls back to default-claude-ctx when both enrichment keys are empty", () => {
    const profile = resolveRetryEnrichmentProfile({}, [claude, claudeCtx]);
    expect(profile?.id).toBe("default-claude-ctx");
  });

  it("skips enrichment fallback when that profile no longer exists, continuing to defaults", () => {
    const profile = resolveRetryEnrichmentProfile({ "adapter.enrichmentProfile": "vanished" }, [
      claude,
      claudeCtx,
    ]);
    expect(profile?.id).toBe("default-claude-ctx");
  });
});

// resolveSplitTaskCwd was removed in the fix for issue #504; Split Task /
// Retry Enrichment now delegate cwd resolution to
// AgentProfileManager.resolveCwd, which is covered by
// src/core/agents/AgentProfileManager.test.ts.
