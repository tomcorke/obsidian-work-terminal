/**
 * CLI launch helpers: PATH augmentation, command resolution, and agent argument builders.
 */
import { expandTilde, electronRequire } from "../utils";
import { type AgentType, getLaunchConfig } from "./AgentProfile";

/** Static directories that are always included in Unix PATH augmentation. */
const UNIX_STATIC_EXTRA_DIRS = ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"];

const WINDOWS_EXTRA_PATH_DIRS = [
  "%LOCALAPPDATA%\\Programs\\node",
  "%APPDATA%\\nvm",
  "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links",
  "%ProgramFiles%\\nodejs",
];

function expandWindowsEnvVars(p: string, env: NodeJS.ProcessEnv): string {
  return p.replace(/%([^%]+)%/g, (_match, varName: string) => env[varName] ?? `%${varName}%`);
}

/**
 * Resolve the nvm default Node.js bin directory by reading ~/.nvm/alias/default.
 *
 * nvm does not create a `current` symlink. Instead, the active version is set
 * via shell init scripts that modify PATH. For GUI-launched processes (like
 * Obsidian), the shell init hasn't run, so we read the default alias file to
 * discover which version the user has configured and return its bin directory.
 *
 * Returns null if nvm is not installed or the alias cannot be resolved.
 */
export function resolveNvmDefaultBin(): string | null {
  try {
    const fs = electronRequire("fs") as typeof import("fs");
    const nvmDir = expandTilde("~/.nvm");
    const aliasPath = `${nvmDir}/alias/default`;

    if (!fs.existsSync(aliasPath)) return null;

    let version = fs.readFileSync(aliasPath, "utf8").trim();
    if (!version) return null;

    // The alias may be a named alias (e.g. "lts/*", "node") or a version
    // string (e.g. "v22.22.0", "22.22.0"). Resolve named aliases by following
    // the chain.
    const maxDepth = 5;
    for (let i = 0; i < maxDepth; i++) {
      const nextAliasPath = `${nvmDir}/alias/${version}`;
      if (fs.existsSync(nextAliasPath)) {
        version = fs.readFileSync(nextAliasPath, "utf8").trim();
        if (!version) return null;
      } else {
        break;
      }
    }

    // Ensure version has a "v" prefix for directory lookup
    if (!version.startsWith("v")) version = `v${version}`;

    const binDir = `${nvmDir}/versions/node/${version}/bin`;
    if (fs.existsSync(binDir)) return binDir;

    // Try partial version match (e.g. "v22" -> "v22.22.0")
    const versionsDir = `${nvmDir}/versions/node`;
    if (fs.existsSync(versionsDir)) {
      const numericCollator = new Intl.Collator(undefined, { numeric: true });
      const entries = fs.readdirSync(versionsDir).sort(numericCollator.compare).reverse();
      const match = entries.find((e) => e.startsWith(version));
      if (match) {
        const matchBin = `${versionsDir}/${match}/bin`;
        if (fs.existsSync(matchBin)) return matchBin;
      }
    }
  } catch {
    // nvm not installed or alias unreadable - not an error
  }
  return null;
}

/**
 * Resolve the fnm default Node.js bin directory.
 *
 * fnm (Fast Node Manager) stores its versions under FNM_DIR, XDG_DATA_HOME/fnm,
 * or ~/.local/share/fnm, with an "aliases/default" symlink. Returns the bin
 * directory of the default version, or null if fnm is not installed.
 */
export function resolveFnmDefaultBin(): string | null {
  try {
    const fs = electronRequire("fs") as typeof import("fs");

    // fnm stores data in FNM_DIR, XDG_DATA_HOME/fnm, or ~/.local/share/fnm
    const fnmDir = process.env.FNM_DIR
      ? expandTilde(process.env.FNM_DIR)
      : process.env.XDG_DATA_HOME
        ? expandTilde(`${process.env.XDG_DATA_HOME}/fnm`)
        : expandTilde("~/.local/share/fnm");
    const aliasDir = `${fnmDir}/aliases/default`;

    // fnm creates a symlink at aliases/default -> the version directory
    if (fs.existsSync(aliasDir)) {
      const binDir = `${aliasDir}/bin`;
      if (fs.existsSync(binDir)) return binDir;
      // Some fnm layouts put the binary in installation/bin
      const installBin = `${aliasDir}/installation/bin`;
      if (fs.existsSync(installBin)) return installBin;
    }
  } catch {
    // fnm not installed - not an error
  }
  return null;
}

/** Cached nvm/fnm resolution results (process lifetime, like login-shell PATH). */
let _nvmBinCache: string | null = null;
let _nvmBinResolved = false;
let _fnmBinCache: string | null = null;
let _fnmBinResolved = false;

/** Return cached nvm default bin dir, resolving on first call. */
function getCachedNvmBin(): string | null {
  if (!_nvmBinResolved) {
    _nvmBinResolved = true;
    _nvmBinCache = resolveNvmDefaultBin();
  }
  return _nvmBinCache;
}

/** Return cached fnm default bin dir, resolving on first call. */
function getCachedFnmBin(): string | null {
  if (!_fnmBinResolved) {
    _fnmBinResolved = true;
    _fnmBinCache = resolveFnmDefaultBin();
  }
  return _fnmBinCache;
}

/** Reset cached nvm/fnm bin paths (for testing). */
export function _resetNvmFnmBinCache(): void {
  _nvmBinCache = null;
  _nvmBinResolved = false;
  _fnmBinCache = null;
  _fnmBinResolved = false;
}

/**
 * Return platform-appropriate extra PATH directories.
 *
 * When `includeDynamic` is true (default), also resolves nvm/fnm default
 * version bin directories via cached filesystem probing. Set to false when
 * login-shell PATH already includes these (to avoid overriding the shell's
 * own resolution).
 */
export function getExtraPathDirs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  includeDynamic = true,
): string[] {
  if (isWindowsPlatform(platform)) {
    return WINDOWS_EXTRA_PATH_DIRS.map((d) => expandWindowsEnvVars(d, env));
  }

  const dirs = UNIX_STATIC_EXTRA_DIRS.map((d) => expandTilde(d));

  if (includeDynamic) {
    // Dynamically resolve nvm/fnm default version bin directories
    const nvmBin = getCachedNvmBin();
    if (nvmBin) dirs.push(nvmBin);

    const fnmBin = getCachedFnmBin();
    if (fnmBin) dirs.push(fnmBin);
  }

  return dirs;
}

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

// ---------------------------------------------------------------------------
// Login-shell PATH resolution
// ---------------------------------------------------------------------------

/** Cached result from resolveLoginShellPath(). */
let _loginShellPathCache: string | null = null;
let _loginShellPathResolved = false;

/**
 * Resolve the user's full PATH by spawning a login shell.
 *
 * Electron inherits a limited environment from the OS launcher (e.g. Finder on
 * macOS), which typically lacks nvm/fnm/Homebrew paths. This function spawns the
 * user's configured shell as a login-interactive shell and reads the PATH it
 * produces. The result is cached for the process lifetime.
 *
 * Falls back to null if the shell fails or times out (2s).
 */
export function resolveLoginShellPath(): string | null {
  if (_loginShellPathResolved) return _loginShellPathCache;
  _loginShellPathResolved = true;

  if (isWindowsPlatform(process.platform)) {
    // Windows doesn't use login shells the same way; skip.
    return null;
  }

  try {
    const cp = electronRequire("child_process") as typeof import("child_process");
    const userShell = process.env.SHELL || "/bin/zsh";

    // Use -ilc to get a login-interactive shell that sources profile files,
    // then prints PATH. The printf avoids trailing newlines.
    const PATH_START = "___PATH_START___";
    const PATH_END = "___PATH_END___";
    const result = cp.spawnSync(
      userShell,
      ["-ilc", `printf "${PATH_START}%s${PATH_END}" "$PATH"`],
      {
        encoding: "utf8",
        timeout: 2000,
        env: {
          HOME: process.env.HOME,
          USER: process.env.USER,
          SHELL: process.env.SHELL,
          TERM: "dumb",
        },
      },
    );

    if (result.status === 0 && result.stdout) {
      // Extract PATH from between sentinels to ignore shell greeting/profile noise
      const startIdx = result.stdout.indexOf(PATH_START);
      const endIdx = result.stdout.indexOf(PATH_END);
      if (startIdx !== -1 && endIdx !== -1) {
        _loginShellPathCache = result.stdout.slice(startIdx + PATH_START.length, endIdx);
      } else {
        // Fallback: use raw stdout if sentinels are missing
        _loginShellPathCache = result.stdout;
      }
      console.log("[work-terminal] Resolved login shell PATH:", _loginShellPathCache.slice(0, 200));
      return _loginShellPathCache;
    }

    console.warn("[work-terminal] Login shell PATH resolution returned status:", result.status);
    if (result.stderr) {
      // Only log first 200 chars of stderr to avoid noise from shell greeting text
      console.warn("[work-terminal] Login shell stderr:", result.stderr.slice(0, 200));
    }
  } catch (err) {
    console.warn("[work-terminal] Failed to resolve login shell PATH:", err);
  }

  return null;
}

/**
 * Build the full augmented PATH including the user's login-shell PATH.
 *
 * When login-shell PATH resolution succeeds, merges (in priority order):
 * 1. Login shell PATH (nvm, fnm, Homebrew, etc. - already resolved by shell init)
 * 2. Static extra dirs (~/.local/bin, /usr/local/bin, /opt/homebrew/bin)
 * 3. Current process.env.PATH (Electron baseline)
 *
 * When login-shell PATH resolution fails, falls back to:
 * 1. Static extra dirs + dynamically resolved nvm/fnm bin dirs
 * 2. Current process.env.PATH (Electron baseline)
 *
 * Deduplicates while preserving order.
 */
export function getFullPath(
  env: NodeJS.ProcessEnv = process.env,
  pathModule: PathModule = electronRequire("path") as PathModule,
  platform: NodeJS.Platform = process.platform,
): string {
  const delimiter = getPathDelimiter(pathModule, platform);
  const loginPath = resolveLoginShellPath();
  const existingDirs = (
    env.PATH || (isWindowsPlatform(platform) ? "" : "/usr/local/bin:/usr/bin:/bin")
  ).split(delimiter);

  let all: string[];
  if (loginPath) {
    // Login shell succeeded - it already includes nvm/fnm paths from shell init.
    // Only add static extra dirs as supplements, not dynamic nvm/fnm probing.
    const staticDirs = getExtraPathDirs(platform, env, /* includeDynamic */ false);
    const loginDirs = loginPath.split(delimiter);
    all = [...loginDirs, ...staticDirs, ...existingDirs];
  } else {
    // Login shell failed - use dynamic nvm/fnm resolution as fallback.
    const extraDirs = getExtraPathDirs(platform, env, /* includeDynamic */ true);
    all = [...extraDirs, ...existingDirs];
  }

  return [...new Set(all.filter(Boolean))].join(delimiter);
}

/** Reset cached login-shell PATH and nvm/fnm caches (for testing). */
export function _resetLoginShellPathCache(): void {
  _loginShellPathCache = null;
  _loginShellPathResolved = false;
  _resetNvmFnmBinCache();
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
  const pathDirs = getFullPath(env, pathModule, platform).split(delimiter).filter(Boolean);
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
  const config = getLaunchConfig(agent);
  const normalized = command.trim() || config.defaultCommand || agent;
  return `${config.cliDisplayName} not found for "${normalized}". ${config.installHint}`;
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
 * Build agent CLI argument array from agent type config, extra args, and optional prompt.
 *
 * Uses AgentLaunchConfig to determine:
 * - How the prompt is injected (promptInjectionMode / promptFlag)
 * - Whether additionalAgentContext is appended to the prompt (all agent types)
 */
export function buildAgentArgs(
  agentType: AgentType,
  extraArgs?: string,
  prompt?: string,
  additionalAgentContext?: string,
  launchConfigOverride?: import("./AgentProfile").AgentLaunchConfig,
): string[] {
  const config = launchConfigOverride ?? getLaunchConfig(agentType);
  const args: string[] = [];

  if (extraArgs) {
    args.push(...parseExtraArgs(extraArgs));
  }

  if (prompt) {
    let fullPrompt = prompt;
    if (additionalAgentContext) {
      fullPrompt += "\n\n" + additionalAgentContext;
    }
    if (config.promptInjectionMode === "flag" && config.promptFlag) {
      args.push(config.promptFlag, fullPrompt);
    } else {
      // positional: append prompt as trailing arg
      args.push(fullPrompt);
    }
  }

  return args;
}

/**
 * Build GitHub Copilot CLI argument array from settings and optional prompt.
 * @deprecated Use buildAgentArgs("copilot", ...) instead. Kept for backward compatibility.
 */
export function buildCopilotArgs(
  settings: {
    copilotExtraArgs?: string;
  },
  prompt?: string,
): string[] {
  return buildAgentArgs("copilot", settings.copilotExtraArgs, prompt);
}

/**
 * Build AWS Strands agent argument array from settings and optional prompt.
 * @deprecated Use buildAgentArgs("strands", ...) instead. Kept for backward compatibility.
 */
export function buildStrandsArgs(
  settings: {
    strandsExtraArgs?: string;
  },
  prompt?: string,
): string[] {
  return buildAgentArgs("strands", settings.strandsExtraArgs, prompt);
}
