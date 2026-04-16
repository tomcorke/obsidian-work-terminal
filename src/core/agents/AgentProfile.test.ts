import { describe, expect, it } from "vitest";
import {
  AGENT_TYPES,
  AgentProfileArraySchema,
  AgentProfileSchema,
  BRAND_COLORS,
  agentTypeToSessionType,
  sessionTypeToAgentType,
  isProfileSessionType,
  extractProfileId,
  PROFILE_SESSION_PREFIX,
  createDefaultProfile,
  createDefaultClaudeProfile,
  createDefaultClaudeCtxProfile,
  createDefaultCopilotProfile,
  getBuiltInProfiles,
} from "./AgentProfile";

describe("agentTypeToSessionType", () => {
  it("maps claude without context", () => {
    expect(agentTypeToSessionType("claude", false)).toBe("claude");
  });
  it("maps claude with context", () => {
    expect(agentTypeToSessionType("claude", true)).toBe("claude-with-context");
  });
  it("maps copilot without context", () => {
    expect(agentTypeToSessionType("copilot", false)).toBe("copilot");
  });
  it("maps copilot with context", () => {
    expect(agentTypeToSessionType("copilot", true)).toBe("copilot-with-context");
  });
  it("maps strands without context", () => {
    expect(agentTypeToSessionType("strands", false)).toBe("strands");
  });
  it("maps strands with context", () => {
    expect(agentTypeToSessionType("strands", true)).toBe("strands-with-context");
  });
  it("maps shell (ignores context)", () => {
    expect(agentTypeToSessionType("shell", false)).toBe("shell");
    expect(agentTypeToSessionType("shell", true)).toBe("shell");
  });
});

describe("sessionTypeToAgentType", () => {
  it("maps claude session types", () => {
    expect(sessionTypeToAgentType("claude")).toEqual({ agentType: "claude", withContext: false });
    expect(sessionTypeToAgentType("claude-with-context")).toEqual({
      agentType: "claude",
      withContext: true,
    });
  });
  it("maps copilot session types", () => {
    expect(sessionTypeToAgentType("copilot")).toEqual({ agentType: "copilot", withContext: false });
    expect(sessionTypeToAgentType("copilot-with-context")).toEqual({
      agentType: "copilot",
      withContext: true,
    });
  });
  it("maps strands session types", () => {
    expect(sessionTypeToAgentType("strands")).toEqual({ agentType: "strands", withContext: false });
    expect(sessionTypeToAgentType("strands-with-context")).toEqual({
      agentType: "strands",
      withContext: true,
    });
  });
  it("maps shell", () => {
    expect(sessionTypeToAgentType("shell")).toEqual({ agentType: "shell", withContext: false });
  });
});

describe("createDefaultProfile", () => {
  it("creates a profile with defaults", () => {
    const profile = createDefaultProfile();
    expect(profile.id).toBeTruthy();
    expect(profile.name).toBe("New Profile");
    expect(profile.agentType).toBe("claude");
    expect(profile.button.enabled).toBe(false);
  });

  it("applies overrides", () => {
    const profile = createDefaultProfile({ name: "Test", agentType: "copilot" });
    expect(profile.name).toBe("Test");
    expect(profile.agentType).toBe("copilot");
  });
});

describe("built-in profiles", () => {
  it("creates default Claude profile with button enabled", () => {
    const profile = createDefaultClaudeProfile();
    expect(profile.id).toBe("default-claude");
    expect(profile.name).toBe("Claude");
    expect(profile.agentType).toBe("claude");
    expect(profile.useContext).toBe(false);
    expect(profile.button.enabled).toBe(true);
    expect(profile.button.icon).toBe("claude");
  });

  it("creates default Claude ctx profile with context enabled", () => {
    const profile = createDefaultClaudeCtxProfile();
    expect(profile.id).toBe("default-claude-ctx");
    expect(profile.useContext).toBe(true);
    expect(profile.button.enabled).toBe(true);
    expect(profile.button.borderStyle).toBe("dashed");
  });

  it("creates default Copilot profile with button disabled", () => {
    const profile = createDefaultCopilotProfile();
    expect(profile.id).toBe("default-copilot");
    expect(profile.agentType).toBe("copilot");
    expect(profile.button.enabled).toBe(false);
  });

  it("returns three built-in profiles", () => {
    const profiles = getBuiltInProfiles();
    expect(profiles).toHaveLength(3);
    expect(profiles[0].name).toBe("Claude");
    expect(profiles[1].name).toBe("Claude (ctx)");
    expect(profiles[2].name).toBe("Copilot");
  });
});

describe("zod validation", () => {
  it("validates a valid profile", () => {
    const profile = createDefaultClaudeProfile();
    const result = AgentProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it("rejects a profile with missing name", () => {
    const profile = { ...createDefaultClaudeProfile(), name: "" };
    const result = AgentProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it("rejects a profile with invalid agent type", () => {
    const profile = { ...createDefaultClaudeProfile(), agentType: "invalid" };
    const result = AgentProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });

  it("validates an array of profiles", () => {
    const profiles = getBuiltInProfiles();
    const result = AgentProfileArraySchema.safeParse(profiles);
    expect(result.success).toBe(true);
  });

  it("rejects invalid array entries", () => {
    const result = AgentProfileArraySchema.safeParse([{ bad: "data" }]);
    expect(result.success).toBe(false);
  });
});

describe("BRAND_COLORS", () => {
  it("defines colors for all branded icons", () => {
    expect(BRAND_COLORS.claude).toBe("#D97757");
    expect(BRAND_COLORS.copilot).toBe("#6E40C9");
    expect(BRAND_COLORS.aws).toBe("#FF9900");
    expect(BRAND_COLORS.skyscanner).toBe("#0770E3");
  });

  it("does not define colors for non-branded icons", () => {
    expect(BRAND_COLORS.terminal).toBeUndefined();
    expect(BRAND_COLORS.bee).toBeUndefined();
  });
});

describe("default profile button colors", () => {
  it("sets Claude brand color on the default Claude profile", () => {
    const profile = createDefaultClaudeProfile();
    expect(profile.button.color).toBe(BRAND_COLORS.claude);
  });

  it("sets Claude brand color on the default Claude (ctx) profile", () => {
    const profile = createDefaultClaudeCtxProfile();
    expect(profile.button.color).toBe(BRAND_COLORS.claude);
  });

  it("does not set a color on the default Copilot profile", () => {
    const profile = createDefaultCopilotProfile();
    expect(profile.button.color).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Custom agent type
// ---------------------------------------------------------------------------

describe("custom agent type", () => {
  it("is included in AGENT_TYPES", () => {
    expect(AGENT_TYPES).toContain("custom");
  });
});

describe("profile session type helpers", () => {
  it("agentTypeToSessionType returns profile-prefixed type for custom with profileId", () => {
    const sessionType = agentTypeToSessionType("custom", false, "abc-123");
    expect(sessionType).toBe(`${PROFILE_SESSION_PREFIX}abc-123`);
  });

  it("agentTypeToSessionType returns 'custom' when no profileId", () => {
    const sessionType = agentTypeToSessionType("custom", false);
    expect(sessionType).toBe("custom");
  });

  it("isProfileSessionType detects profile-prefixed session types", () => {
    expect(isProfileSessionType("profile:abc-123")).toBe(true);
    expect(isProfileSessionType("claude")).toBe(false);
    expect(isProfileSessionType("custom")).toBe(false);
  });

  it("extractProfileId extracts the ID from a profile session type", () => {
    expect(extractProfileId("profile:abc-123")).toBe("abc-123");
    expect(extractProfileId("claude")).toBeUndefined();
  });

  it("sessionTypeToAgentType maps profile session types to custom", () => {
    const result = sessionTypeToAgentType("profile:abc-123");
    expect(result.agentType).toBe("custom");
    expect(result.withContext).toBe(false);
  });

  it("sessionTypeToAgentType maps 'custom' to custom", () => {
    const result = sessionTypeToAgentType("custom");
    expect(result.agentType).toBe("custom");
  });

  it("sessionTypeToAgentType falls back to custom for unknown types", () => {
    const result = sessionTypeToAgentType("unknown-type" as any);
    expect(result.agentType).toBe("custom");
  });
});

describe("Zod schema for custom profiles", () => {
  it("validates a profile with promptInjectionMode override", () => {
    const raw = {
      id: "test-1",
      name: "Pi Agent",
      agentType: "custom",
      command: "pi",
      defaultCwd: "",
      arguments: "",
      contextPrompt: "",
      useContext: false,
      suppressAdapterPrompt: false,
      button: { enabled: true, label: "Pi" },
      sortOrder: 0,
      promptInjectionMode: "positional",
    };
    const result = AgentProfileSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("validates a minimal custom profile", () => {
    const raw = {
      id: "test-2",
      name: "Simple CLI",
      agentType: "custom",
      command: "mycli",
      defaultCwd: "",
      arguments: "",
      contextPrompt: "",
      useContext: false,
      suppressAdapterPrompt: false,
      button: { enabled: false, label: "" },
      sortOrder: 0,
    };
    const result = AgentProfileSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});
