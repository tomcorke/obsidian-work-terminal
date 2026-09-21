import { electronRequire } from "../utils";

const SHELL_EXECUTABLES = new Set([
  "/bin/zsh",
  "/bin/bash",
  "/bin/sh",
  "/usr/bin/zsh",
  "/usr/bin/bash",
  "zsh",
  "bash",
  "sh",
]);

export function getDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") return env.ComSpec || env.COMSPEC || "cmd.exe";
  return env.SHELL || "/bin/zsh";
}

export function getInteractiveShellCommand(
  shell: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "win32" ? [shell] : [shell, "-i"];
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Resolve configured CWD using the path rules of the target platform. */
export function resolveTerminalCwd(
  value: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = value.trim() || "~";
  const home =
    platform === "win32" ? env.USERPROFILE || env.HOME || "" : env.HOME || env.USERPROFILE || "";
  const expanded =
    raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? home + raw.slice(1) : raw;
  const absolute =
    platform === "win32" ? isWindowsAbsolutePath(expanded) : expanded.startsWith("/");
  if (absolute || !home) return expanded;

  try {
    const path = electronRequire("path") as {
      win32?: { resolve(...paths: string[]): string };
      posix?: { resolve(...paths: string[]): string };
    };
    const resolver = platform === "win32" ? path.win32 : path.posix;
    if (resolver) return resolver.resolve(home, expanded);
  } catch {
    // Fall back to a simple home-relative path when path loading is unavailable.
  }

  const separator = platform === "win32" ? "\\" : "/";
  return `${home.replace(/[\\/]+$/, "")}${separator}${expanded.replace(/^[/\\]+/, "")}`;
}

export interface PtyLaunchPlan {
  python: { executable: string; argv: string[] };
  child: { executable: string; argv: string[] };
  loginShellWrapped: boolean;
}

export interface ConptyLaunchPlan {
  backend: "conpty";
  command: { executable: string; argv: string[] };
  cols: number;
  rows: number;
}

export type TerminalLaunchPlan = PtyLaunchPlan | ConptyLaunchPlan;

/** Match Python shlex.quote(), which pty-wrapper.py historically used. */
export function quoteShellArg(value: string): string {
  if (!value) return "''";
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPtyLaunchPlan(options: {
  python3Path: string;
  wrapperPath: string;
  cols: number;
  rows: number;
  command: string[];
  loginShellWrap?: boolean;
  shell?: string;
}): PtyLaunchPlan {
  const command =
    options.command.length > 0 ? options.command : [options.shell || getDefaultShell(), "-i"];
  const direct =
    SHELL_EXECUTABLES.has(command[0]) ||
    (command[0].startsWith("/") && options.loginShellWrap !== true);
  const shell = options.shell || getDefaultShell();
  const childArgv = direct
    ? command
    : [shell, "-l", "-i", "-c", command.map(quoteShellArg).join(" ")];

  return {
    python: {
      executable: options.python3Path,
      argv: [
        options.python3Path,
        options.wrapperPath,
        String(options.cols),
        String(options.rows),
        "--resolved",
        "--",
        ...childArgv,
      ],
    },
    child: { executable: childArgv[0], argv: childArgv },
    loginShellWrapped: !direct,
  };
}

export function buildConptyLaunchPlan(options: {
  cols: number;
  rows: number;
  command: string[];
  shell?: string;
}): ConptyLaunchPlan {
  const argv =
    options.command.length > 0 ? options.command : [options.shell || getDefaultShell("win32")];
  return {
    backend: "conpty",
    command: { executable: argv[0], argv },
    cols: options.cols,
    rows: options.rows,
  };
}

export function resolvePtyWrapperPath(pluginDir?: string): string {
  const path = electronRequire("path") as typeof import("path");
  const fs = electronRequire("fs") as typeof import("fs");
  const candidates = [
    ...(pluginDir ? [path.join(pluginDir, "pty-wrapper.py")] : []),
    path.join(__dirname, "pty-wrapper.py"),
  ];

  return (
    candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) ||
    candidates[0] ||
    "pty-wrapper.py"
  );
}
