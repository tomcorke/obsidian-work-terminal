/**
 * CLI launch helpers: PATH augmentation, command resolution, and agent argument builders.
 */
import { expandTilde, electronRequire } from "../utils";
import { type AgentType, getResumeConfig } from "./AgentProfile";

const EXTRA_PATH_DIRS = [
  "~/.local/bin",
  "~/.nvm/versions/node/current/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

type FsModule = typeof import("fs");
type PathModule = typeof import("path");

export interface ResolveCommandInfoDeps {
  fs?: FsModule;
  pathModule?: PathModule;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function isWindowsPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function getPathDelimiter(pathModule: PathModule, platform: NodeJS.Platform): string {
  return isWindowsPlatform(platform) ? pathModule.win32.delimiter : pathModule.delimiter;
}

function isWindowsAbsolutePath(command: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(command) || command.startsWith("\\\\");
}

function isWindowsPathLike(command: string): boolean {
  return isWindowsAbsolutePath(command) || command.includes("\\");
}

function getPathVariant(
  pathModule: PathModule,
  value: string,
  platform: NodeJS.Platform,
  cwd?: string,
): typeof import("path").posix | typeof import("path").win32 {
  if (isWindowsPlatform(platform) || isWindowsPathLike(value) || (cwd && isWindowsPathLike(cwd))) {
    return pathModule.win32;
  }
  return pathModule.posix;
}

function getWindowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function getExecutableCandidates(
  pathToCheck: string,
  pathModule: PathModule,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!isWindowsPlatform(platform)) {
    return [pathToCheck];
  }
  const ext = pathModule.win32.extname(pathToCheck);
  if (ext) {
    return [pathToCheck];
  }
  return [
    pathToCheck,
    ...getWindowsExecutableExtensions(env).map((entry) => `${pathToCheck}${entry}`),
  ];
}

function safeIsExecutable(
  fs: FsModule,
  pathToCheck: string,
  pathModule: PathModule,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    const stats = fs.statSync(pathToCheck);
    if (stats.isDirectory()) {
      return false;
    }
    if (isWindowsPlatform(platform)) {
      const ext = pathModule.win32.extname(pathToCheck).toLowerCase();
      return !!ext && getWindowsExecutableExtensions(env).includes(ext);
    }
    fs.accessSync(pathToCheck, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findLaunchablePath(
  fs: FsModule,
  pathToCheck: string,
  pathModule: PathModule,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const candidate of getExecutableCandidates(pathToCheck, pathModule, platform, env)) {
    if (safeIsExecutable(fs, candidate, pathModule, platform, env)) {
      return candidate;
    }
  }
  return null;
}

export function isAbsoluteCommandPath(
  command: string,
  pathModule: PathModule = electronRequire("path") as PathModule,
): boolean {
  return pathModule.isAbsolute(command) || isWindowsAbsolutePath(command);
}

export function isPathLikeCommand(command: string): boolean {
  return command.includes("/") || isWindowsPathLike(command);
}

/**
 * Build an augmented PATH that includes common tool directories.
 * Deduplicates entries while preserving order (extra dirs first, then existing).
 */
export function augmentPath(
  env: NodeJS.ProcessEnv = process.env,
  pathModule: PathModule = electronRequire("path") as PathModule,
  platform: NodeJS.Platform = process.platform,
): string {
  const delimiter = getPathDelimiter(pathModule, platform);
  const existing = env.PATH || (isWindowsPlatform(platform) ? "" : "/usr/local/bin:/usr/bin:/bin");
  const dirs = EXTRA_PATH_DIRS.map((d) => expandTilde(d));
  const all = [...dirs, ...existing.split(delimiter)].filter(Boolean);
  return [...new Set(all)].join(delimiter);
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

export function resolveCommandInfo(
  cmd: string,
  cwd?: string,
  deps: ResolveCommandInfoDeps = {},
): ResolvedCommand {
  const requested = cmd.trim();
  const fs = deps.fs ?? (electronRequire("fs") as FsModule);
  const pathModule = deps.pathModule ?? (electronRequire("path") as PathModule);
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (!requested) {
    return { requested, resolved: requested, found: false };
  }
  const expanded = requested.startsWith("~") ? expandTilde(requested) : requested;
  if (isAbsoluteCommandPath(expanded, pathModule)) {
    const foundPath = findLaunchablePath(fs, expanded, pathModule, platform, env);
    return {
      requested,
      resolved: foundPath ?? expanded,
      found: !!foundPath,
    };
  }
  if (isPathLikeCommand(expanded)) {
    if (cwd) {
      const expandedCwd = expandTilde(cwd);
      const pathVariant = getPathVariant(pathModule, expanded, platform, expandedCwd);
      const resolved = pathVariant.resolve(expandedCwd, expanded);
      const foundPath = findLaunchablePath(fs, resolved, pathModule, platform, env);
      return {
        requested,
        resolved: foundPath ?? resolved,
        found: !!foundPath,
      };
    }
    return {
      requested,
      resolved: expanded,
      found: false,
    };
  }
  const delimiter = getPathDelimiter(pathModule, platform);
  const pathDirs = augmentPath(env, pathModule, platform).split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const pathVariant = getPathVariant(pathModule, dir, platform);
    const full = pathVariant.join(dir, expanded);
    try {
      const foundPath = findLaunchablePath(fs, full, pathModule, platform, env);
      if (foundPath) {
        return { requested, resolved: foundPath, found: true };
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

export function buildMissingCliNotice(agent: AgentType, command: string): string {
  const config = getResumeConfig(agent);
  const normalized = command.trim() || config.defaultCommand || agent;
  return `${config.cliDisplayName} not found for "${normalized}". ${config.installHint}`;
}

export function splitConfiguredCommand(command: string): string[] {
  const normalized = normalizeExtraArgs(command);
  if (!normalized) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (quote === null && /\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      if (quote === null) {
        quote = char;
        tokenStarted = true;
        continue;
      }
      if (quote === char) {
        quote = null;
        continue;
      }
    }

    if (char === "\\") {
      const next = normalized[index + 1];
      if (next !== undefined) {
        if (quote === '"') {
          if (next === '"') {
            current += next;
            tokenStarted = true;
            index += 1;
            continue;
          }
        } else if (quote === null && (/\s/.test(next) || next === '"' || next === "'")) {
          current += next;
          tokenStarted = true;
          index += 1;
          continue;
        }
      }
    }

    current += char;
    tokenStarted = true;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
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
