import { describe, expect, it } from "vitest";
import {
  AgentProfileArraySchema,
  AgentProfileSchema,
  BRAND_COLORS,
  agentTypeToSessionType,
  sessionTypeToAgentType,
  createDefaultProfile,
  createDefaultClaudeProfile,
  createDefaultClaudeCtxProfile,
  createDefaultCopilotProfile,
  getBuiltInProfiles,
  getResumeConfig,
  isResumableAgentType,
  hasSessionTracking,
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

describe("getResumeConfig", () => {
  it("returns resumable config for claude", () => {
    const config = getResumeConfig("claude");
    expect(config.resumable).toBe(true);
    expect(config.sessionTracking).toBe(true);
    expect(config.resumeFlagFormat).toBe("flag-space");
    expect(config.resumeFlag).toBe("--session-id");
    expect(config.promptInjectionMode).toBe("positional");
    expect(config.commandSettingKey).toBe("core.claudeCommand");
    expect(config.defaultCommand).toBe("claude");
    expect(config.extraArgsSettingKey).toBe("core.claudeExtraArgs");
  });

  it("returns resumable config for copilot with equals format", () => {
    const config = getResumeConfig("copilot");
    expect(config.resumable).toBe(true);
    expect(config.sessionTracking).toBe(false);
    expect(config.resumeFlagFormat).toBe("flag-equals");
    expect(config.resumeFlag).toBe("--resume");
    expect(config.commandSettingKey).toBe("core.copilotCommand");
    expect(config.defaultCommand).toBe("copilot");
  });

  it("returns non-resumable config for strands", () => {
    const config = getResumeConfig("strands");
    expect(config.resumable).toBe(false);
    expect(config.sessionTracking).toBe(false);
  });

  it("returns non-resumable config for shell", () => {
    const config = getResumeConfig("shell");
    expect(config.resumable).toBe(false);
  });
});

describe("isResumableAgentType", () => {
  it("returns true for claude and copilot", () => {
    expect(isResumableAgentType("claude")).toBe(true);
    expect(isResumableAgentType("copilot")).toBe(true);
  });

  it("returns false for strands and shell", () => {
    expect(isResumableAgentType("strands")).toBe(false);
    expect(isResumableAgentType("shell")).toBe(false);
  });
});

describe("hasSessionTracking", () => {
  it("returns true only for claude", () => {
    expect(hasSessionTracking("claude")).toBe(true);
    expect(hasSessionTracking("copilot")).toBe(false);
    expect(hasSessionTracking("strands")).toBe(false);
    expect(hasSessionTracking("shell")).toBe(false);
  });
});

describe("resume config display fields", () => {
  it("provides displayLabel for all agent types", () => {
    expect(getResumeConfig("claude").displayLabel).toBe("Claude");
    expect(getResumeConfig("copilot").displayLabel).toBe("Copilot");
    expect(getResumeConfig("strands").displayLabel).toBe("Strands");
    expect(getResumeConfig("shell").displayLabel).toBe("Shell");
  });

  it("provides helpText for all agent types", () => {
    expect(getResumeConfig("claude").helpText).toContain("--session-id");
    expect(getResumeConfig("copilot").helpText).toContain("--resume[=sessionId]");
    expect(getResumeConfig("strands").helpText).toContain("start fresh");
    expect(getResumeConfig("shell").helpText).toContain("not saved for restart resume");
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
