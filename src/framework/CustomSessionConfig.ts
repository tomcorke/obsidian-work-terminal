import type { SessionType } from "../core/session/types";
import {
  type AgentType,
  sessionTypeToAgentType,
  getResumeConfig,
  hasSessionTracking,
  isProfileSessionType,
} from "../core/agents/AgentProfile";

export interface CustomSessionConfig {
  sessionType: SessionType;
  cwd: string;
  extraArgs: string;
  label: string;
}

export const CUSTOM_SESSION_TYPE_OPTIONS: Array<{ value: SessionType; label: string }> = [
  { value: "shell", label: "Shell" },
  { value: "claude", label: "Claude" },
  { value: "claude-with-context", label: "Claude (ctx)" },
  { value: "copilot", label: "Copilot" },
  { value: "copilot-with-context", label: "Copilot (ctx)" },
  { value: "strands", label: "Strands" },
  { value: "strands-with-context", label: "Strands (ctx)" },
  { value: "custom", label: "Custom" },
];

export function createDefaultCustomSessionConfig(defaultCwd: string): CustomSessionConfig {
  return {
    sessionType: "claude",
    cwd: defaultCwd,
    extraArgs: "",
    label: "",
  };
}

export function sanitizeCustomSessionConfig(
  value: Partial<CustomSessionConfig> | null | undefined,
  defaultCwd: string,
): CustomSessionConfig {
  const sessionType = isSessionType(value?.sessionType) ? value.sessionType : "claude";
  return {
    sessionType,
    cwd: typeof value?.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : defaultCwd,
    extraArgs: typeof value?.extraArgs === "string" ? value.extraArgs.trim() : "",
    label: typeof value?.label === "string" ? value.label.trim() : "",
  };
}

export function getDefaultSessionLabel(sessionType: SessionType): string {
  const { agentType, withContext } = sessionTypeToAgentType(sessionType);
  const config = getResumeConfig(agentType);
  return withContext ? `${config.displayLabel} (ctx)` : config.displayLabel;
}

export function getSessionTypeHelp(sessionType: SessionType): string {
  const { agentType } = sessionTypeToAgentType(sessionType);
  return getResumeConfig(agentType).helpText;
}

export function isContextSession(sessionType: SessionType): boolean {
  return sessionTypeToAgentType(sessionType).withContext;
}

/**
 * Check whether a session type belongs to a given agent type.
 */
export function isAgentTypeSession(sessionType: SessionType, target: AgentType): boolean {
  return sessionTypeToAgentType(sessionType).agentType === target;
}

/**
 * Check whether a session type uses session tracking (e.g. Claude hooks).
 */
export function isSessionTrackingSession(sessionType: SessionType): boolean {
  return hasSessionTracking(sessionTypeToAgentType(sessionType).agentType);
}

export function isCopilotSession(sessionType: SessionType): boolean {
  return isAgentTypeSession(sessionType, "copilot");
}

export function isClaudeSession(sessionType: SessionType): boolean {
  return isAgentTypeSession(sessionType, "claude");
}

export function isStrandsSession(sessionType: SessionType): boolean {
  return isAgentTypeSession(sessionType, "strands");
}

export function isCustomSession(sessionType: SessionType): boolean {
  return isAgentTypeSession(sessionType, "custom");
}

export function supportsExtraArgs(sessionType: SessionType): boolean {
  return sessionTypeToAgentType(sessionType).agentType !== "shell";
}

function isSessionType(value: unknown): value is SessionType {
  return (
    (typeof value === "string" && isProfileSessionType(value)) ||
    CUSTOM_SESSION_TYPE_OPTIONS.some((option) => option.value === value)
  );
}
