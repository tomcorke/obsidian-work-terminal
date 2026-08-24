import { mergeExtraArgs, parseExtraArgs } from "../core/agents/AgentLauncher";
import type { AgentProfile } from "../core/agents/AgentProfile";

export const REASONING_EFFORTS = ["", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ActionOverrides {
  model: string;
  effort: ReasoningEffort;
}

export function getActionOverrides(
  settings: Record<string, unknown>,
  prefix: string,
): ActionOverrides {
  const effort = settings[`${prefix}Effort`];
  return {
    model: typeof settings[`${prefix}Model`] === "string" ? settings[`${prefix}Model`].trim() : "",
    effort:
      typeof effort === "string" && REASONING_EFFORTS.includes(effort as ReasoningEffort)
        ? (effort as ReasoningEffort)
        : "",
  };
}

export function supportsModelOverride(profile: AgentProfile): boolean {
  return (
    profile.modelFlag !== "" &&
    (profile.modelFlag != null || ["claude", "copilot", "opencode"].includes(profile.agentType))
  );
}

export function supportsEffortOverride(profile: AgentProfile): boolean {
  return (
    profile.effortFlag !== "" && (profile.effortFlag != null || profile.agentType === "claude")
  );
}

export function applyActionOverrides(
  profile: AgentProfile,
  overrides: ActionOverrides,
): AgentProfile {
  const pairs: Array<[string | undefined, string]> = [
    [
      profile.modelFlag ??
        (["claude", "copilot", "opencode"].includes(profile.agentType) ? "--model" : undefined),
      overrides.model,
    ],
    [
      profile.effortFlag ?? (profile.agentType === "claude" ? "--effort" : undefined),
      overrides.effort,
    ],
  ];
  let args = parseExtraArgs(profile.arguments);
  for (const [flag, value] of pairs) {
    if (!flag || !value) continue;
    const index = args.indexOf(flag);
    if (index >= 0) args.splice(index, args[index + 1]?.startsWith("-") ? 1 : 2);
    args = [...args, flag, value];
  }
  return { ...profile, arguments: mergeExtraArgs(args.join(" ")) };
}
