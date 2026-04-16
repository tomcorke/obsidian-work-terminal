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
  "pi",
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
  pi: "#00C853",
};

// ---------------------------------------------------------------------------
// Agent types (maps to session type families)
// ---------------------------------------------------------------------------

export const AGENT_TYPES = ["claude", "copilot", "strands", "shell", "custom"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

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
  /** When true, the adapter's base prompt is not prepended to the context prompt. */
  suppressAdapterPrompt: boolean;
  button: ProfileButton;
  /** Order index for sorting in the UI. Lower values first. */
  sortOrder: number;
  /** How context prompt is passed: "positional" = trailing arg, "flag" = via promptFlag. */
  promptInjectionMode?: "positional" | "flag";
  /** CLI flag for injecting context prompt (e.g. "-i"). Used when promptInjectionMode is "flag". */
  promptFlag?: string;
  /**
   * When true, the command is launched through a login shell even if it
   * resolves to an absolute path. This preserves shell wrapper functions
   * (e.g. auto-update wrappers) defined in ~/.zshrc or ~/.bashrc.
   */
  loginShellWrap?: boolean;
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
const PROMPT_INJECTION_MODES = ["positional", "flag"] as const;

const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agentType: z.enum(AGENT_TYPES),
  command: z.string(),
  defaultCwd: z.string(),
  arguments: z.string(),
  contextPrompt: z.string(),
  useContext: z.boolean(),
  suppressAdapterPrompt: z.boolean(),
  button: ProfileButtonSchema,
  sortOrder: z.number(),
  promptInjectionMode: z.enum(PROMPT_INJECTION_MODES).optional(),
  promptFlag: z.string().optional(),
  loginShellWrap: z.boolean().optional(),
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
    suppressAdapterPrompt: z.boolean().default(false),
    button: ProfileButtonSchema.default({
      enabled: false,
      label: "Agent",
    }),
    sortOrder: z.number().default(0),
    promptInjectionMode: z.enum(PROMPT_INJECTION_MODES).optional(),
    promptFlag: z.string().optional(),
    loginShellWrap: z.boolean().optional(),
  })
  .passthrough();

export const StoredProfileArraySchema = z.array(StoredProfileSchema);

export const AgentProfileArraySchema = z.array(AgentProfileSchema);

export { AgentProfileSchema };

// ---------------------------------------------------------------------------
// Launch configuration per agent type
// ---------------------------------------------------------------------------

export interface AgentLaunchConfig {
  /** How the context prompt is passed to the CLI: "positional" = trailing arg, "flag" = via promptFlag. */
  promptInjectionMode: "positional" | "flag";
  /** CLI flag for injecting the context prompt (e.g. "-i"). Only used when promptInjectionMode is "flag". */
  promptFlag?: string;
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
  /** Human-readable label for the agent type (e.g. "Claude"). */
  displayLabel: string;
  /**
   * Patterns for detecting agent activity in the terminal buffer.
   * - `activeLinePatterns`: regexes tested per-line against the last 6 screen lines.
   * - `activeJoinedPatterns`: regexes tested against the joined/compact tail string.
   * When empty, active indicator detection is skipped (agent stays inactive/idle).
   */
  activityPatterns?: {
    activeLinePatterns: RegExp[];
    activeJoinedPatterns: RegExp[];
  };
}

const AGENT_LAUNCH_CONFIGS: Record<AgentType, AgentLaunchConfig> = {
  claude: {
    promptInjectionMode: "positional",
    commandSettingKey: "core.claudeCommand",
    defaultCommand: "claude",
    extraArgsSettingKey: "core.claudeExtraArgs",
    cliDisplayName: "Claude Code CLI",
    installHint:
      "Install it first, for example with brew install --cask claude-code, then update Work Terminal's Claude command setting if needed.",
    displayLabel: "Claude",
    activityPatterns: {
      activeLinePatterns: [
        /^\s*\u2733.*\u2026/, // spinner with ellipsis = in progress
        /^\s*\u23bf\s+.*\u2026/, // tool output with ellipsis = running
      ],
      activeJoinedPatterns: [
        /\u2733.*\u2026/, // wrapped spinner: char on one row, ellipsis on another
      ],
    },
  },
  copilot: {
    promptInjectionMode: "flag",
    promptFlag: "-i",
    commandSettingKey: "core.copilotCommand",
    defaultCommand: "copilot",
    extraArgsSettingKey: "core.copilotExtraArgs",
    cliDisplayName: "GitHub Copilot CLI",
    installHint:
      "Install it first, for example with brew install copilot-cli, then update Work Terminal's Copilot command setting if needed.",
    displayLabel: "Copilot",
    activityPatterns: {
      activeLinePatterns: [
        /^\s*[\u25c9\u25ce\u25cb\u25cf]\s+(?:Thinking|Executing|Cancelling)\b/, // known status labels
      ],
      activeJoinedPatterns: [
        /[\u25c9\u25ce\u25cb\u25cf].*\(Esc\s+to\s+cancel(?:\s+\u00b7\s+[^)]*)?\)/, // spinner + cancel hint
      ],
    },
  },
  strands: {
    promptInjectionMode: "positional",
    commandSettingKey: "core.strandsCommand",
    defaultCommand: "strands",
    extraArgsSettingKey: "core.strandsExtraArgs",
    cliDisplayName: "Strands agent",
    installHint: "Point the Strands command to a wrapper script in Work Terminal settings.",
    displayLabel: "Strands",
  },
  shell: {
    promptInjectionMode: "positional",
    commandSettingKey: "core.defaultShell",
    defaultCommand: "",
    extraArgsSettingKey: "",
    cliDisplayName: "Shell",
    installHint: "",
    displayLabel: "Shell",
  },
  custom: {
    promptInjectionMode: "positional",
    commandSettingKey: "",
    defaultCommand: "",
    extraArgsSettingKey: "",
    cliDisplayName: "Custom CLI",
    installHint: "",
    displayLabel: "Custom",
  },
};

/**
 * Get launch configuration for an agent type.
 */
export function getLaunchConfig(agentType: AgentType): AgentLaunchConfig {
  return AGENT_LAUNCH_CONFIGS[agentType];
}

/**
 * Build a launch config for a custom profile by merging profile-level overrides
 * onto the base "custom" agent type config.
 */
export function getProfileLaunchConfig(profile: AgentProfile): AgentLaunchConfig {
  const base = getLaunchConfig(profile.agentType);
  if (profile.agentType !== "custom") return base;
  return {
    ...base,
    promptInjectionMode: profile.promptInjectionMode ?? base.promptInjectionMode,
    promptFlag: profile.promptFlag ?? base.promptFlag,
    cliDisplayName: profile.name || base.cliDisplayName,
    displayLabel: profile.name || base.displayLabel,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix used for profile-based session types (custom agent profiles). */
export const PROFILE_SESSION_PREFIX = "profile:";

/**
 * Map an agent type to a session type string.
 * For custom agents, pass a profileId to get a profile-scoped session type.
 */
export function agentTypeToSessionType(
  agentType: AgentType,
  withContext: boolean,
  profileId?: string,
): SessionType {
  switch (agentType) {
    case "claude":
      return withContext ? "claude-with-context" : "claude";
    case "copilot":
      return withContext ? "copilot-with-context" : "copilot";
    case "strands":
      return withContext ? "strands-with-context" : "strands";
    case "shell":
      return "shell";
    case "custom":
      return profileId ? `${PROFILE_SESSION_PREFIX}${profileId}` : "custom";
  }
}

/**
 * Check whether a session type is a profile-based custom session.
 */
export function isProfileSessionType(sessionType: string): boolean {
  return sessionType.startsWith(PROFILE_SESSION_PREFIX);
}

/**
 * Extract the profile ID from a profile-based session type.
 * Returns undefined if the session type is not profile-based.
 */
export function extractProfileId(sessionType: string): string | undefined {
  if (!sessionType.startsWith(PROFILE_SESSION_PREFIX)) return undefined;
  return sessionType.slice(PROFILE_SESSION_PREFIX.length);
}

export function sessionTypeToAgentType(sessionType: SessionType): {
  agentType: AgentType;
  withContext: boolean;
} {
  // Profile-based session types are always custom agents
  if (isProfileSessionType(sessionType)) {
    return { agentType: "custom", withContext: false };
  }
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
    case "custom":
      return { agentType: "custom", withContext: false };
    default:
      console.warn(`Unknown session type "${sessionType}", treating as custom`);
      return { agentType: "custom", withContext: false };
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
    suppressAdapterPrompt: false,
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
    suppressAdapterPrompt: false,
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
    suppressAdapterPrompt: false,
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
    suppressAdapterPrompt: false,
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
