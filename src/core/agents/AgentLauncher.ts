/**
 * CLI launch helpers: PATH augmentation, command resolution, and agent argument builders.
 */
import { expandTilde, electronRequire } from "../utils";

const EXTRA_PATH_DIRS = [
  "~/.local/bin",
  "~/.nvm/versions/node/current/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

/**
 * Build an augmented PATH that includes common tool directories.
 * Deduplicates entries while preserving order (extra dirs first, then existing).
 */
export function augmentPath(): string {
  const existing = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const dirs = EXTRA_PATH_DIRS.map((d) => expandTilde(d));
  const all = [...dirs, ...existing.split(":")];
  return [...new Set(all)].join(":");
}

/**
 * Resolve a command name to its absolute path by searching the augmented PATH.
 * Returns the original command as fallback if not found.
 */
export interface ResolvedCommand {
  requested: string;
  resolved: string;
  found: boolean;
}

export function resolveCommandInfo(cmd: string): ResolvedCommand {
  const requested = cmd.trim();
  const fs = electronRequire("fs") as typeof import("fs");
  if (!requested) {
    return { requested, resolved: requested, found: false };
  }
  const expanded = requested.startsWith("~") ? expandTilde(requested) : requested;
  if (expanded.startsWith("/")) {
    return {
      requested,
      resolved: expanded,
      found: fs.existsSync(expanded),
    };
  }
  if (expanded.includes("/")) {
    return {
      requested,
      resolved: expanded,
      found: true,
    };
  }
  const path = electronRequire("path") as typeof import("path");
  const pathDirs = augmentPath().split(":");
  for (const dir of pathDirs) {
    const full = path.join(dir, expanded);
    try {
      if (fs.existsSync(full)) {
        return { requested, resolved: full, found: true };
      }
    } catch {
      /* skip inaccessible dirs */
    }
  }
  return { requested, resolved: requested, found: false };
}

export function resolveCommand(cmd: string): string {
  return resolveCommandInfo(cmd).resolved;
}

export function buildMissingCliNotice(agent: "claude" | "copilot", command: string): string {
  const normalized = command.trim() || (agent === "claude" ? "claude" : "copilot");
  if (agent === "claude") {
    return `Claude Code CLI not found for "${normalized}". Install it first, for example with brew install --cask claude-code, then update Work Terminal's Claude command setting if needed.`;
  }
  return `GitHub Copilot CLI not found for "${normalized}". Install it first, for example with brew install copilot-cli, then update Work Terminal's Copilot command setting if needed.`;
}

export function normalizeExtraArgs(extraArgs = ""): string {
  return extraArgs.replace(/\\\r?\n[ \t]*/g, " ").trim();
}

export function parseExtraArgs(extraArgs = ""): string[] {
  const normalized = normalizeExtraArgs(extraArgs);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

export function mergeExtraArgs(...extraArgs: Array<string | undefined>): string {
  return extraArgs.flatMap((value) => parseExtraArgs(value)).join(" ");
}

/**
 * Build Claude CLI argument array from settings, session ID, and optional prompt.
 */
export function buildClaudeArgs(
  settings: {
    claudeExtraArgs?: string;
    additionalAgentContext?: string;
  },
  sessionId: string,
  prompt?: string,
): string[] {
  const args: string[] = [];
  if (settings.claudeExtraArgs) {
    args.push(...parseExtraArgs(settings.claudeExtraArgs));
  }
  args.push("--session-id", sessionId);
  if (prompt) {
    let fullPrompt = prompt;
    if (settings.additionalAgentContext) {
      fullPrompt += "\n\n" + settings.additionalAgentContext;
    }
    // Pass as positional arg (initial message in interactive session),
    // not -p (which is one-shot print mode that exits after response).
    args.push(fullPrompt);
  }
  return args;
}

/**
 * Build GitHub Copilot CLI argument array from settings and optional prompt.
 */
export function buildCopilotArgs(
  settings: {
    copilotExtraArgs?: string;
  },
  prompt?: string,
): string[] {
  const args: string[] = [];
  if (settings.copilotExtraArgs) {
    args.push(...parseExtraArgs(settings.copilotExtraArgs));
  }
  if (prompt) {
    args.push("-i", prompt);
  }
  return args;
}

/**
 * Build AWS Strands agent argument array from settings and optional prompt.
 * The Strands SDK has no standard CLI binary - the command is user-configured.
 * Extra args are space-split and passed through; the prompt (if any) is appended as a
 * positional argument so users can pipe context into their agent entry-point.
 */
export function buildStrandsArgs(
  settings: {
    strandsExtraArgs?: string;
  },
  prompt?: string,
): string[] {
  const args: string[] = [];
  if (settings.strandsExtraArgs) {
    args.push(...parseExtraArgs(settings.strandsExtraArgs));
  }
  if (prompt) {
    args.push(prompt);
  }
  return args;
}
