import type { SessionType } from "../core/session/types";

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
  switch (sessionType) {
    case "shell":
      return "Shell";
    case "claude":
      return "Claude";
    case "claude-with-context":
      return "Claude (ctx)";
    case "copilot":
      return "Copilot";
    case "copilot-with-context":
      return "Copilot (ctx)";
  }
}

export function isContextSession(sessionType: SessionType): boolean {
  return sessionType === "claude-with-context" || sessionType === "copilot-with-context";
}

export function isCopilotSession(sessionType: SessionType): boolean {
  return sessionType === "copilot" || sessionType === "copilot-with-context";
}

export function supportsExtraArgs(sessionType: SessionType): boolean {
  return sessionType !== "shell";
}

function isSessionType(value: unknown): value is SessionType {
  return CUSTOM_SESSION_TYPE_OPTIONS.some((option) => option.value === value);
}
