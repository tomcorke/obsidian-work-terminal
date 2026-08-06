import type { WorkItem, WorkItemPromptBuilder } from "../core/interfaces";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import {
  agentTypeToSessionType,
  getProfileLaunchConfig,
  validateProfilePromptInjection,
  type AgentLaunchConfig,
  type AgentProfile,
} from "../core/agents/AgentProfile";
import {
  parseExtraArgs,
  resolveAgentInvocation,
  type ResolvedAgentInvocation,
} from "../core/agents/AgentLauncher";
import { expandTilde } from "../core/utils";
import { buildPtyLaunchPlan, type PtyLaunchPlan } from "../core/terminal/PtyLaunch";
import { expandProfilePlaceholders } from "./AgentContextPrompt";

export const PROFILE_PREVIEW_EXAMPLE_ITEM: WorkItem = {
  id: "[example item id]",
  title: "[example task title]",
  state: "[example state]",
  path: "[example vault-relative path]",
  metadata: {},
};

export const PROFILE_PREVIEW_EXAMPLE_ABSOLUTE_PATH = "/example-vault/Tasks/example-task.md";
export const PROFILE_PREVIEW_EXAMPLE_SESSION_ID = "[example session id]";

export type ProfilePromptPlacement =
  | "automatic-positional"
  | "automatic-flag"
  | "manual-escaped"
  | "manual-raw"
  | "not-injected";

export interface ResolvedProfileLaunch {
  sourceLabel: string;
  sessionType: ReturnType<typeof agentTypeToSessionType>;
  command: string;
  cwd: string;
  extraArgs: string;
  prompt?: string;
  launchConfig: AgentLaunchConfig;
  invocation: ResolvedAgentInvocation;
  pty: PtyLaunchPlan;
  promptPlacement: ProfilePromptPlacement;
  error?:
    | "context-item-required"
    | "context-prompt-unavailable"
    | "manual-prompt-placeholder-required";
}

const PROTECTED_PROMPT_MARKER = "\uE000work-terminal-prompt\uE001";

export interface ResolvedProfileArguments {
  expanded: string;
  argv: string[];
}

/** Expand profile placeholders while optionally protecting the prompt as one argv value. */
export function resolveProfileArguments(options: {
  template: string;
  profile: AgentProfile;
  item?: WorkItem;
  sessionId: string;
  prompt?: string;
  absoluteFilePath?: string;
}): ResolvedProfileArguments {
  const { template, profile, item, sessionId, prompt, absoluteFilePath } = options;
  if (!template) return { expanded: template, argv: [] };

  const expanded = item
    ? expandProfilePlaceholders(template, item, sessionId, prompt, absoluteFilePath ?? item.path)
    : template.replaceAll("$workTerminalPrompt", prompt ?? "");
  if (
    !profile.useContext ||
    profile.appendContextPrompt !== false ||
    profile.escapeWorkTerminalPrompt === false
  ) {
    return { expanded, argv: parseExtraArgs(expanded) };
  }

  const protectedTemplate = template.replaceAll("$workTerminalPrompt", PROTECTED_PROMPT_MARKER);
  const protectedExpanded = item
    ? expandProfilePlaceholders(
        protectedTemplate,
        item,
        sessionId,
        undefined,
        absoluteFilePath ?? item.path,
      )
    : protectedTemplate;
  return {
    expanded,
    argv: parseExtraArgs(protectedExpanded).map((arg) =>
      arg.replaceAll(PROTECTED_PROMPT_MARKER, prompt ?? ""),
    ),
  };
}

/**
 * Assemble every profile-specific launch layer before a session is spawned.
 * This is shared by TerminalPanelView and the profile editor preview.
 */
export function resolveProfileLaunch(options: {
  profile: AgentProfile;
  settings: Record<string, unknown>;
  profileManager: AgentProfileManager;
  promptBuilder: WorkItemPromptBuilder;
  item?: WorkItem;
  absoluteFilePath?: string;
  sessionId?: string;
  sourceLabel?: string;
  pty?: {
    python3Path: string;
    wrapperPath: string;
    cols?: number;
    rows?: number;
    shell?: string;
  };
}): ResolvedProfileLaunch {
  const { profile, settings, profileManager } = options;
  const sessionType = agentTypeToSessionType(
    profile.agentType,
    profile.useContext,
    profile.agentType === "custom" ? profile.id : undefined,
  );
  const command = profileManager.resolveCommand(profile, settings);
  const cwd = profileManager.resolveCwd(profile, settings);
  const launchConfig = getProfileLaunchConfig(profile);
  const sourceLabel = options.sourceLabel ?? "Selected work item";
  const item = options.item;
  const sessionId = options.sessionId ?? "$sessionId";

  let prompt: string | undefined;
  let error: ResolvedProfileLaunch["error"];
  // Shell profiles historically ignore context and remain interactive. Context
  // is an agent prompt, not a script for the shell to execute.
  if (profile.useContext && profile.agentType !== "shell") {
    if (!item) {
      error = "context-item-required";
    } else {
      const absolutePath = options.absoluteFilePath ?? item.path;
      const contextTemplate = profileManager.resolveContextPrompt(profile, settings);
      const adapterPrompt = profile.suppressAdapterPrompt
        ? null
        : options.promptBuilder.buildPrompt(item, absolutePath);

      if (contextTemplate) {
        const expandedContext = expandProfilePlaceholders(
          contextTemplate,
          item,
          sessionId,
          undefined,
          absolutePath,
        );
        prompt = adapterPrompt ? `${adapterPrompt}\n\n${expandedContext}` : expandedContext;
      } else {
        prompt = adapterPrompt ?? "";
      }

      if (!prompt && !profile.suppressAdapterPrompt) {
        error = "context-prompt-unavailable";
      }
    }
  }

  const resolvedArguments = resolveProfileArguments({
    template: profileManager.resolveArguments(profile, settings),
    profile,
    item,
    sessionId,
    prompt,
    absoluteFilePath: options.absoluteFilePath,
  });
  const extraArgs = resolvedArguments.expanded;
  const appendAutomatically = profile.appendContextPrompt !== false;
  const promptPlacement: ProfilePromptPlacement = !prompt
    ? "not-injected"
    : appendAutomatically
      ? launchConfig.promptInjectionMode === "flag" && launchConfig.promptFlag
        ? "automatic-flag"
        : "automatic-positional"
      : profile.escapeWorkTerminalPrompt === false
        ? "manual-raw"
        : "manual-escaped";

  if (validateProfilePromptInjection(profile)) {
    error = "manual-prompt-placeholder-required";
  }

  const invocation = resolveAgentInvocation({
    agentType: profile.agentType,
    command,
    cwd,
    extraArgs: resolvedArguments.argv,
    prompt: appendAutomatically ? prompt : undefined,
    launchConfigOverride: profile.agentType === "custom" ? launchConfig : undefined,
    loginShellWrap: profile.loginShellWrap,
  });

  const pty = buildPtyLaunchPlan({
    python3Path: options.pty?.python3Path ?? "python3",
    wrapperPath: options.pty?.wrapperPath ?? "pty-wrapper.py",
    cols: options.pty?.cols ?? 80,
    rows: options.pty?.rows ?? 24,
    command: invocation.argv,
    loginShellWrap: invocation.loginShellWrap,
    shell: options.pty?.shell,
  });

  return {
    sourceLabel,
    sessionType,
    command,
    cwd: expandTilde(cwd),
    extraArgs,
    prompt,
    launchConfig,
    invocation,
    pty,
    promptPlacement,
    error,
  };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Format a launch model with explicit argv indexes and escaped control characters. */
export function formatProfileLaunchPreview(resolved: ResolvedProfileLaunch): string {
  const { invocation, prompt, launchConfig, promptPlacement } = resolved;
  const lines = [
    `Values: ${resolved.sourceLabel}`,
    `Resolved executable: ${quoted(invocation.executable)}`,
    `Working directory: ${quoted(invocation.cwd)}`,
    "",
    "Target command layer:",
  ];

  invocation.argv.forEach((arg, index) => lines.push(`  argv[${index}]: ${quoted(arg)}`));

  lines.push("", "Assembled context prompt:", `  ${prompt ? quoted(prompt) : "(none)"}`);
  if (promptPlacement === "automatic-flag") {
    lines.push(
      `Prompt placement: automatic flag ${quoted(launchConfig.promptFlag!)}, value at argv[${invocation.argv.length - 1}]`,
    );
  } else if (promptPlacement === "automatic-positional") {
    lines.push(`Prompt placement: automatic positional argv[${invocation.argv.length - 1}]`);
  } else if (promptPlacement === "manual-escaped") {
    lines.push(
      "Prompt placement: manual escaped $workTerminalPrompt substitution (one argv value)",
    );
  } else if (promptPlacement === "manual-raw") {
    lines.push("Prompt placement: manual raw $workTerminalPrompt substitution");
  } else {
    lines.push("Prompt placement: not injected");
  }

  lines.push("", "PTY Python wrapper layer:");
  resolved.pty.python.argv.forEach((arg, index) => lines.push(`  argv[${index}]: ${quoted(arg)}`));

  lines.push(
    "",
    resolved.pty.loginShellWrapped ? "Login-shell child layer:" : "Direct child layer:",
  );
  resolved.pty.child.argv.forEach((arg, index) => lines.push(`  argv[${index}]: ${quoted(arg)}`));

  if (!invocation.command.found) {
    lines.push("", `Warning: executable was not found; launch would be blocked.`);
  }
  if (resolved.error) {
    lines.push("", `Warning: ${resolved.error.replaceAll("-", " ")}.`);
  }

  return lines.join("\n");
}
