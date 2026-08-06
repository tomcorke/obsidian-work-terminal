import type { WorkItem, WorkItemPromptBuilder } from "../core/interfaces";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import {
  agentTypeToSessionType,
  getProfileLaunchConfig,
  type AgentLaunchConfig,
  type AgentProfile,
} from "../core/agents/AgentProfile";
import { resolveAgentInvocation, type ResolvedAgentInvocation } from "../core/agents/AgentLauncher";
import { expandTilde } from "../core/utils";
import { expandProfilePlaceholders } from "./AgentContextPrompt";

export const PROFILE_PREVIEW_EXAMPLE_ITEM: WorkItem = {
  id: "[example item id]",
  title: "[example task title]",
  state: "[example state]",
  path: "[example vault-relative path]",
  metadata: {},
};

export const PROFILE_PREVIEW_EXAMPLE_ABSOLUTE_PATH = "[example absolute file path]";
export const PROFILE_PREVIEW_EXAMPLE_SESSION_ID = "[example session id]";

export interface ResolvedProfileLaunch {
  sourceLabel: string;
  sessionType: ReturnType<typeof agentTypeToSessionType>;
  command: string;
  cwd: string;
  extraArgs: string;
  prompt?: string;
  launchConfig: AgentLaunchConfig;
  invocation: ResolvedAgentInvocation;
  error?: "context-item-required" | "context-prompt-unavailable";
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
  if (profile.useContext) {
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

  let extraArgs = profileManager.resolveArguments(profile, settings);
  if (item && extraArgs) {
    extraArgs = expandProfilePlaceholders(
      extraArgs,
      item,
      sessionId,
      prompt,
      options.absoluteFilePath ?? item.path,
    );
  }

  const invocation = resolveAgentInvocation({
    agentType: profile.agentType,
    command,
    cwd,
    extraArgs,
    prompt,
    launchConfigOverride: profile.agentType === "custom" ? launchConfig : undefined,
    loginShellWrap: profile.loginShellWrap,
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
    error,
  };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Format a launch model with explicit argv indexes and escaped control characters. */
export function formatProfileLaunchPreview(resolved: ResolvedProfileLaunch): string {
  const { invocation, prompt, launchConfig } = resolved;
  const lines = [
    `Values: ${resolved.sourceLabel}`,
    `Resolved executable: ${quoted(invocation.executable)}`,
    `Working directory: ${quoted(invocation.cwd)}`,
    "",
    "Target command layer:",
  ];

  invocation.argv.forEach((arg, index) => lines.push(`  argv[${index}]: ${quoted(arg)}`));

  lines.push("", "Assembled context prompt:", `  ${prompt ? quoted(prompt) : "(none)"}`);
  if (prompt) {
    const promptIndex = invocation.argv.length - 1;
    lines.push(
      launchConfig.promptInjectionMode === "flag" && launchConfig.promptFlag
        ? `Prompt placement: flag ${quoted(launchConfig.promptFlag)}, value at argv[${promptIndex}]`
        : `Prompt placement: positional argv[${promptIndex}]`,
    );
  } else {
    lines.push("Prompt placement: not injected");
  }

  lines.push("", "PTY launch layer:", `  process target: ${quoted(invocation.executable)}`);
  if (invocation.loginShellWrap) {
    lines.push(
      `  login shell: ${quoted(process.env.SHELL || "/bin/zsh")} ["-l", "-i", "-c", <shell-quoted target argv>]`,
    );
  } else {
    lines.push("  login shell: disabled");
  }

  if (!invocation.command.found) {
    lines.push("", `Warning: executable was not found; launch would be blocked.`);
  }
  if (resolved.error) {
    lines.push("", `Warning: ${resolved.error.replaceAll("-", " ")}.`);
  }

  return lines.join("\n");
}
