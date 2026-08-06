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

export interface PtyLaunchPlan {
  python: { executable: string; argv: string[] };
  child: { executable: string; argv: string[] };
  loginShellWrapped: boolean;
}

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
    options.command.length > 0 ? options.command : [options.shell || "/bin/zsh", "-i"];
  const direct =
    SHELL_EXECUTABLES.has(command[0]) ||
    (command[0].startsWith("/") && options.loginShellWrap !== true);
  const shell = options.shell || process.env.SHELL || "/bin/zsh";
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
