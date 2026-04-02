/**
 * Agent Profile data model and zod schemas.
 *
 * An AgentProfile defines a reusable agent launch configuration -
 * executable, arguments, context prompt, CWD, and tab bar button styling.
 */
import { z } from "zod";
import type { SessionType } from "../session/types";

// ---------------------------------------------------------------------------
// Icon set
// ---------------------------------------------------------------------------

export const PROFILE_ICONS = [
  // Generic
  "terminal",
  "bot",
  "brain",
  "code",
  "rocket",
  "zap",
  "cog",
  "wrench",
  "shield",
  "globe",
  "search",
  "lightbulb",
  "flask",
  "book",
  "puzzle",
  "bee",
  // Branded
  "claude",
  "copilot",
  "aws",
  "skyscanner",
] as const;

export type ProfileIcon = (typeof PROFILE_ICONS)[number];

export const BORDER_STYLES = ["solid", "dashed", "dotted", "thick"] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];

/** Default brand colors for branded icons. */
export const BRAND_COLORS: Partial<Record<ProfileIcon, string>> = {
  claude: "#D97757",
  copilot: "#6E40C9",
  aws: "#FF9900",
  skyscanner: "#0770E3",
};

// ---------------------------------------------------------------------------
// Agent types (maps to session type families)
// ---------------------------------------------------------------------------

export const AGENT_TYPES = ["claude", "copilot", "strands", "shell"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Placeholder options for launch vs resume
// ---------------------------------------------------------------------------

export const PARAM_PASS_MODES = ["launch-only", "resume-only", "both"] as const;
export type ParamPassMode = (typeof PARAM_PASS_MODES)[number];

// ---------------------------------------------------------------------------
// Button configuration
// ---------------------------------------------------------------------------

export interface ProfileButton {
  enabled: boolean;
  label: string;
  icon?: ProfileIcon;
  borderStyle?: BorderStyle;
  color?: string;
}

// ---------------------------------------------------------------------------
// Agent Profile
// ---------------------------------------------------------------------------

export interface AgentProfile {
  id: string;
  name: string;
  agentType: AgentType;
  command: string;
  defaultCwd: string;
  arguments: string;
  contextPrompt: string;
  useContext: boolean;
  paramPassMode: ParamPassMode;
  button: ProfileButton;
  /** Order index for sorting in the UI. Lower values first. */
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Zod schemas (for import validation)
// ---------------------------------------------------------------------------

const ProfileButtonSchema = z.object({
  enabled: z.boolean(),
  label: z.string(),
  icon: z.enum(PROFILE_ICONS).optional(),
  borderStyle: z.enum(BORDER_STYLES).optional(),
  color: z.string().optional(),
});

/**
 * Strict schema used for import validation - all fields required.
 */
const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agentType: z.enum(AGENT_TYPES),
  command: z.string(),
  defaultCwd: z.string(),
  arguments: z.string(),
  contextPrompt: z.string(),
  useContext: z.boolean(),
  paramPassMode: z.enum(PARAM_PASS_MODES),
  button: ProfileButtonSchema,
  sortOrder: z.number(),
});

/**
 * Lenient schema for loading stored profiles - tolerates missing fields that
 * may not have existed when the profile was originally saved. Missing fields
 * get sensible defaults so user customisations are never silently discarded.
 */
const StoredProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    agentType: z.enum(AGENT_TYPES),
    command: z.string().default(""),
    defaultCwd: z.string().default(""),
    arguments: z.string().default(""),
    contextPrompt: z.string().default(""),
    useContext: z.boolean().default(false),
    paramPassMode: z.enum(PARAM_PASS_MODES).default("launch-only"),
    button: ProfileButtonSchema.default({
      enabled: false,
      label: "Agent",
    }),
    sortOrder: z.number().default(0),
  })
  .passthrough();

export const StoredProfileArraySchema = z.array(StoredProfileSchema);

export const AgentProfileArraySchema = z.array(AgentProfileSchema);

export { AgentProfileSchema };

// ---------------------------------------------------------------------------
// Resume configuration per agent type
// ---------------------------------------------------------------------------

export interface AgentResumeConfig {
  /** Whether this agent type supports session resume. */
  resumable: boolean;
  /** Whether this agent type supports session ID tracking (watching for /resume). */
  sessionTracking: boolean;
  /** How the resume flag is formatted: "flag-space" = --resume ID, "flag-equals" = --resume=ID */
  resumeFlagFormat: "flag-space" | "flag-equals";
  /** The resume flag name (e.g. "--resume"). */
  resumeFlag: string;
  /** Global settings key for the command (e.g. "core.claudeCommand"). */
  commandSettingKey: string;
  /** Default command name when no setting is configured. */
  defaultCommand: string;
  /** Global settings key for extra args (e.g. "core.claudeExtraArgs"). */
  extraArgsSettingKey: string;
  /** Human-readable name for CLI-not-found notices. */
  cliDisplayName: string;
  /** Install hint for CLI-not-found notices. */
  installHint: string;
}

const AGENT_RESUME_CONFIGS: Record<AgentType, AgentResumeConfig> = {
  claude: {
    resumable: true,
    sessionTracking: true,
    resumeFlagFormat: "flag-space",
    resumeFlag: "--resume",
    commandSettingKey: "core.claudeCommand",
    defaultCommand: "claude",
    extraArgsSettingKey: "core.claudeExtraArgs",
    cliDisplayName: "Claude Code CLI",
    installHint:
      "Install it first, for example with brew install --cask claude-code, then update Work Terminal's Claude command setting if needed.",
  },
  copilot: {
    resumable: true,
    sessionTracking: false,
    resumeFlagFormat: "flag-equals",
    resumeFlag: "--resume",
    commandSettingKey: "core.copilotCommand",
    defaultCommand: "copilot",
    extraArgsSettingKey: "core.copilotExtraArgs",
    cliDisplayName: "GitHub Copilot CLI",
    installHint:
      "Install it first, for example with brew install copilot-cli, then update Work Terminal's Copilot command setting if needed.",
  },
  strands: {
    resumable: false,
    sessionTracking: false,
    resumeFlagFormat: "flag-space",
    resumeFlag: "--resume",
    commandSettingKey: "core.strandsCommand",
    defaultCommand: "strands",
    extraArgsSettingKey: "core.strandsExtraArgs",
    cliDisplayName: "Strands agent",
    installHint: "Configure the Strands command in Work Terminal settings.",
  },
  shell: {
    resumable: false,
    sessionTracking: false,
    resumeFlagFormat: "flag-space",
    resumeFlag: "",
    commandSettingKey: "core.defaultShell",
    defaultCommand: "",
    extraArgsSettingKey: "",
    cliDisplayName: "Shell",
    installHint: "",
  },
};

/**
 * Get resume configuration for an agent type.
 */
export function getResumeConfig(agentType: AgentType): AgentResumeConfig {
  return AGENT_RESUME_CONFIGS[agentType];
}

/**
 * Check whether an agent type supports session resume.
 */
export function isResumableAgentType(agentType: AgentType): boolean {
  return AGENT_RESUME_CONFIGS[agentType].resumable;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function agentTypeToSessionType(agentType: AgentType, withContext: boolean): SessionType {
  switch (agentType) {
    case "claude":
      return withContext ? "claude-with-context" : "claude";
    case "copilot":
      return withContext ? "copilot-with-context" : "copilot";
    case "strands":
      return withContext ? "strands-with-context" : "strands";
    case "shell":
      return "shell";
  }
}

export function sessionTypeToAgentType(sessionType: SessionType): {
  agentType: AgentType;
  withContext: boolean;
} {
  switch (sessionType) {
    case "claude":
      return { agentType: "claude", withContext: false };
    case "claude-with-context":
      return { agentType: "claude", withContext: true };
    case "copilot":
      return { agentType: "copilot", withContext: false };
    case "copilot-with-context":
      return { agentType: "copilot", withContext: true };
    case "strands":
      return { agentType: "strands", withContext: false };
    case "strands-with-context":
      return { agentType: "strands", withContext: true };
    case "shell":
      return { agentType: "shell", withContext: false };
  }
}

export function createDefaultProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    id: crypto.randomUUID(),
    name: "New Profile",
    agentType: "claude",
    command: "",
    defaultCwd: "",
    arguments: "",
    contextPrompt: "",
    useContext: false,
    paramPassMode: "launch-only",
    button: {
      enabled: false,
      label: "",
    },
    sortOrder: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default profiles that ship with the plugin
// ---------------------------------------------------------------------------

export function createDefaultClaudeProfile(sortOrder = 0): AgentProfile {
  return {
    id: "default-claude",
    name: "Claude",
    agentType: "claude",
    command: "",
    defaultCwd: "",
    arguments: "",
    contextPrompt: "",
    useContext: false,
    paramPassMode: "launch-only",
    button: {
      enabled: true,
      label: "Claude",
      icon: "claude",
      borderStyle: "solid",
      color: BRAND_COLORS.claude,
    },
    sortOrder,
  };
}

export function createDefaultClaudeCtxProfile(sortOrder = 1): AgentProfile {
  return {
    id: "default-claude-ctx",
    name: "Claude (ctx)",
    agentType: "claude",
    command: "",
    defaultCwd: "",
    arguments: "",
    contextPrompt: "",
    useContext: true,
    paramPassMode: "launch-only",
    button: {
      enabled: true,
      label: "Claude (ctx)",
      icon: "claude",
      borderStyle: "dashed",
      color: BRAND_COLORS.claude,
    },
    sortOrder,
  };
}

export function createDefaultCopilotProfile(sortOrder = 2): AgentProfile {
  return {
    id: "default-copilot",
    name: "Copilot",
    agentType: "copilot",
    command: "",
    defaultCwd: "",
    arguments: "",
    contextPrompt: "",
    useContext: false,
    paramPassMode: "launch-only",
    button: {
      enabled: false,
      label: "Copilot",
      icon: "copilot",
      borderStyle: "solid",
    },
    sortOrder,
  };
}

export function getBuiltInProfiles(): AgentProfile[] {
  return [
    createDefaultClaudeProfile(),
    createDefaultClaudeCtxProfile(),
    createDefaultCopilotProfile(),
  ];
}
