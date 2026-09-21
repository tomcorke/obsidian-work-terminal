import { electronRequire } from "../utils";
import { loadBundledNodePty } from "./BundledNodePty";
import { buildPtyLaunchPlan, getDefaultShell } from "./PtyLaunch";

export type PtyBackendKind = "python" | "conpty";

export interface TerminalInput {
  destroyed: boolean;
  write(data: string): void;
}

/**
 * Process surface shared by the POSIX Python wrapper and Windows ConPTY.
 * TerminalTab never needs to know how bytes reach or leave the pseudo-terminal.
 */
export interface TerminalProcess {
  readonly pid: number | null;
  readonly stdin: TerminalInput;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  onData(listener: (data: Buffer | string) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  resize(cols: number, rows: number): void;
  kill(force?: boolean): void;
}

export interface PtySpawnOptions {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  command: string[];
  env: NodeJS.ProcessEnv;
  python3Path?: string;
  wrapperPath?: string;
  pluginDir?: string;
  loginShellWrap?: boolean;
}

export interface PtyBackend {
  readonly kind: PtyBackendKind;
  spawn(options: PtySpawnOptions): TerminalProcess;
}

export interface NodePtyInstance {
  readonly pid: number;
  readonly onData: (listener: (data: string) => void) => { dispose(): void };
  readonly onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
    dispose(): void;
  };
  onError?: (listener: (error: Error) => void) => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      useConpty: boolean;
      useConptyDll: boolean;
    },
  ): NodePtyInstance;
}

interface ChildProcessSource {
  readonly pid?: number;
  readonly stdin?: {
    readonly destroyed?: boolean;
    write(data: string): unknown;
  } | null;
  readonly stdout?: {
    on(event: "data", listener: (data: Buffer | string) => void): unknown;
  } | null;
  readonly stderr?: {
    on(event: "data", listener: (data: Buffer | string) => void): unknown;
  } | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ChildSpawnOptions {
  cwd: string;
  stdio: ["pipe", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

export interface PtyBackendDependencies {
  spawnChild?: (command: string, args: string[], options: ChildSpawnOptions) => ChildProcessSource;
  loadNodePty?: (pluginDir?: string) => NodePtyModule;
}

export class PtyBackendUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      "Native Windows terminal backend is unavailable. Reinstall Work Terminal " +
        "from a release that includes the ConPTY helper, then retry. " +
        `(${detail})`,
    );
    this.name = "PtyBackendUnavailableError";
  }
}

class PythonPtyProcess implements TerminalProcess {
  readonly stdin: TerminalInput;

  constructor(private readonly child: ChildProcessSource) {
    this.stdin = {
      get destroyed() {
        return !child.stdin || child.stdin.destroyed === true || child.killed;
      },
      write: (data: string) => {
        if (!child.stdin || child.stdin.destroyed || child.killed) return;
        child.stdin.write(data);
      },
    };
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get killed(): boolean {
    return this.child.killed;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): string | null {
    return this.child.signalCode;
  }

  onData(listener: (data: Buffer | string) => void): void {
    this.child.stdout?.on("data", listener);
    this.child.stderr?.on("data", listener);
  }

  onError(listener: (error: Error) => void): void {
    this.child.on("error", listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.child.on("exit", listener);
  }

  resize(cols: number, rows: number): void {
    this.stdin.write(`\x1b]777;resize;${cols};${rows}\x07`);
  }

  kill(force = false): void {
    if (this.child.killed) return;
    try {
      this.child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The child may have exited between the status check and kill().
    }
  }
}

class ConptyProcess implements TerminalProcess {
  private _killed = false;
  private _exitCode: number | null = null;
  private _signalCode: string | null = null;
  private readonly dataListeners: Array<(data: Buffer | string) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  readonly stdin: TerminalInput = {
    destroyed: false,
    write: (data: string) => this.write(data),
  };

  constructor(private readonly pty: NodePtyInstance) {
    pty.onData((data) => {
      for (const listener of this.dataListeners) listener(data);
    });
    pty.onExit(({ exitCode, signal }) => {
      this._exitCode = exitCode;
      this._signalCode = signal === undefined ? null : String(signal);
      this.stdin.destroyed = true;
      for (const listener of this.exitListeners) listener(exitCode, this._signalCode);
    });
    pty.onError?.((error) => this.reportError(error));
  }

  get pid(): number {
    return this.pty.pid;
  }

  get killed(): boolean {
    return this._killed;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get signalCode(): string | null {
    return this._signalCode;
  }

  write(data: string): void {
    if (this.stdin.destroyed) return;
    try {
      this.pty.write(data);
    } catch (error) {
      this.reportError(error);
    }
  }

  onData(listener: (data: Buffer | string) => void): void {
    this.dataListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.errorListeners) listener(normalized);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  resize(cols: number, rows: number): void {
    if (this.stdin.destroyed) return;
    try {
      this.pty.resize(cols, rows);
    } catch (error) {
      this.reportError(error);
    }
  }

  kill(): void {
    if (this._killed || this._exitCode !== null) return;
    this._killed = true;
    this.stdin.destroyed = true;
    try {
      this.pty.kill();
    } catch {
      // The native process may have exited while cleanup was running.
    }
  }
}

class PythonPtyBackend implements PtyBackend {
  readonly kind = "python" as const;

  constructor(private readonly spawnChild: NonNullable<PtyBackendDependencies["spawnChild"]>) {}

  spawn(options: PtySpawnOptions): TerminalProcess {
    const plan = buildPtyLaunchPlan({
      python3Path: options.python3Path ?? "python3",
      wrapperPath: options.wrapperPath ?? "pty-wrapper.py",
      cols: options.cols,
      rows: options.rows,
      command: options.command,
      loginShellWrap: options.loginShellWrap,
      shell: options.shell,
    });
    const child = this.spawnChild(plan.python.executable, plan.python.argv.slice(1), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
    });
    return new PythonPtyProcess(child);
  }
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s\t"&|<>^()]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      result += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function resolveConptyCommand(options: PtySpawnOptions): {
  file: string;
  args: string[] | string;
} {
  const command = options.command.length > 0 ? options.command : [options.shell];
  const [file, ...args] = command;
  if (!file) throw new Error("No Windows terminal command configured");
  if (!/\.(?:cmd|bat)$/i.test(file)) return { file, args };

  const commandLine = [file, ...args].map(quoteWindowsArgument).join(" ");
  return {
    file: getDefaultShell("win32", options.env),
    args: commandLine.startsWith('"') ? `/d /c "${commandLine}"` : `/d /c ${commandLine}`,
  };
}

class ConptyBackend implements PtyBackend {
  readonly kind = "conpty" as const;
  private nodePty: NodePtyModule | null = null;

  constructor(private readonly loadNodePty: (pluginDir?: string) => NodePtyModule) {}

  spawn(options: PtySpawnOptions): TerminalProcess {
    try {
      this.nodePty ??= this.loadNodePty(options.pluginDir);
      const { file, args } = resolveConptyCommand(options);
      const pty = this.nodePty.spawn(file, args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
        useConpty: true,
        // Use node-pty's bundled ConPTY shim so cleanup does not depend on
        // attaching a helper process to Obsidian's renderer console.
        useConptyDll: true,
      });
      return new ConptyProcess(pty);
    } catch (error) {
      if (error instanceof PtyBackendUnavailableError) throw error;
      throw new PtyBackendUnavailableError(error);
    }
  }
}

function defaultChildSpawner(
  command: string,
  args: string[],
  options: ChildSpawnOptions,
): ChildProcessSource {
  const childProcess = electronRequire("child_process") as {
    spawn(command: string, args: string[], options: ChildSpawnOptions): ChildProcessSource;
  };
  return childProcess.spawn(command, args, options);
}

function defaultNodePtyLoader(pluginDir?: string): NodePtyModule {
  return loadBundledNodePty(pluginDir);
}

export function createPtyBackend(
  platform: NodeJS.Platform = process.platform,
  dependencies: PtyBackendDependencies = {},
): PtyBackend {
  if (platform === "win32") {
    return new ConptyBackend(dependencies.loadNodePty ?? defaultNodePtyLoader);
  }
  return new PythonPtyBackend(dependencies.spawnChild ?? defaultChildSpawner);
}

export function getPtyBackendKind(platform: NodeJS.Platform = process.platform): PtyBackendKind {
  return platform === "win32" ? "conpty" : "python";
}
