import type { AgentProfile } from "../core/agents/AgentProfile";

const DEFAULT_CONTEXT_ID = "default-claude-ctx";
const DEFAULT_ID = "default-claude";

export function resolveActionProfile(
  settings: Record<string, unknown>,
  availableProfiles: AgentProfile[],
  settingKey: string,
  fallbackSettingKeys: string[] = [],
): AgentProfile | null {
  const byId = new Map(availableProfiles.map((profile) => [profile.id, profile]));
  for (const key of [settingKey, ...fallbackSettingKeys]) {
    const id = settings[key];
    if (typeof id === "string" && id.trim() && byId.has(id.trim())) return byId.get(id.trim())!;
  }
  return byId.get(DEFAULT_CONTEXT_ID) ?? byId.get(DEFAULT_ID) ?? availableProfiles[0] ?? null;
}

export function resolveSplitTaskProfile(
  settings: Record<string, unknown>,
  availableProfiles: AgentProfile[],
): AgentProfile | null {
  return resolveActionProfile(settings, availableProfiles, "adapter.splitTaskProfile");
}

export function resolveCreateSubTaskProfile(
  settings: Record<string, unknown>,
  availableProfiles: AgentProfile[],
): AgentProfile | null {
  return resolveActionProfile(settings, availableProfiles, "adapter.createSubTaskProfile", [
    "adapter.splitTaskProfile",
  ]);
}

export function resolveRetryEnrichmentProfile(
  settings: Record<string, unknown>,
  availableProfiles: AgentProfile[],
): AgentProfile | null {
  return resolveActionProfile(settings, availableProfiles, "adapter.retryEnrichmentProfile", [
    "adapter.enrichmentProfile",
  ]);
}

export function isClaudeProfile(profile: AgentProfile): boolean {
  return profile.agentType === "claude";
}
