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
export function resolveCommand(cmd: string): string {
  if (cmd.startsWith("/")) return cmd;
  const fs = electronRequire("fs") as typeof import("fs");
  const path = electronRequire("path") as typeof import("path");
  const pathDirs = augmentPath().split(":");
  for (const dir of pathDirs) {
    const full = path.join(dir, cmd);
    try {
      if (fs.existsSync(full)) return full;
    } catch {
      /* skip inaccessible dirs */
    }
  }
  return cmd; // fallback to bare command
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
    args.push(...settings.claudeExtraArgs.split(/\s+/).filter(Boolean));
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
    args.push(...settings.copilotExtraArgs.split(/\s+/).filter(Boolean));
  }
  if (prompt) {
    args.push("-i", prompt);
  }
  return args;
}
