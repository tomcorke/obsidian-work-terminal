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
  { value: "strands", label: "Strands" },
  { value: "strands-with-context", label: "Strands (ctx)" },
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
    case "strands":
      return "Strands";
    case "strands-with-context":
      return "Strands (ctx)";
  }
}

export function getSessionTypeHelp(sessionType: SessionType): string {
  switch (sessionType) {
    case "shell":
      return "Shell tabs are local terminals only and are not saved for restart resume.";
    case "claude":
    case "claude-with-context":
      return "Claude starts new sessions with --session-id. Restart resume works from the stored session ID, but if you run /resume inside Claude you should install the Claude hooks in settings so Work Terminal can follow the new session ID.";
    case "copilot":
    case "copilot-with-context":
      return "Copilot uses --resume[=sessionId] for both new and resumed sessions. Restart resume works without Claude hooks. If you switch sessions manually inside Copilot, Work Terminal keeps tracking the original session ID.";
    case "strands":
    case "strands-with-context":
      return "Strands sessions start fresh each time. Work Terminal does not persist restart-resume metadata for them.";
  }
}

export function isContextSession(sessionType: SessionType): boolean {
  return (
    sessionType === "claude-with-context" ||
    sessionType === "copilot-with-context" ||
    sessionType === "strands-with-context"
  );
}

export function isCopilotSession(sessionType: SessionType): boolean {
  return sessionType === "copilot" || sessionType === "copilot-with-context";
}

export function isStrandsSession(sessionType: SessionType): boolean {
  return sessionType === "strands" || sessionType === "strands-with-context";
}

export function supportsExtraArgs(sessionType: SessionType): boolean {
  return sessionType !== "shell";
}

function isSessionType(value: unknown): value is SessionType {
  return CUSTOM_SESSION_TYPE_OPTIONS.some((option) => option.value === value);
}
