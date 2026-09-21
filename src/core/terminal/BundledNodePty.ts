import { electronRequire } from "../utils";
import type { NodePtyInstance, NodePtyModule } from "./PtyBackend";
import { ensureWindowsPtyAssets } from "./WindowsPtyAssetsLoader";

type PtySpawnOptions = Parameters<NodePtyModule["spawn"]>[2];
type ParentMessage =
  | { type: "start"; file: string; args: string[] | string; options: PtySpawnOptions }
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" };
type ChildMessage = {
  type: "ready" | "data" | "exit" | "error";
  data?: string;
  pid?: number;
  exitCode?: number;
  signal?: number;
  error?: string;
};

type ProcessAdapter = {
  readonly pid?: number;
  onMessage(listener: (message: ChildMessage) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null) => void): void;
  send(message: ParentMessage): void;
  kill(): void;
};

type UtilityProcess = {
  readonly pid?: number;
  on(event: "message", listener: (message: ChildMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: ParentMessage): void;
  kill(): void;
};

type UtilityProcessModule = {
  fork(modulePath: string, args: string[], options: { serviceName: string }): UtilityProcess;
};

type ChildProcess = {
  readonly pid?: number;
  on(event: "message", listener: (message: ChildMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  send(message: ParentMessage): boolean;
  kill(): boolean;
};

class ForkedNodePtyInstance implements NodePtyInstance {
  private _pid: number;
  private _killed = false;
  private exited = false;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> =
    [];

  constructor(
    private readonly child: ProcessAdapter,
    start: Extract<ParentMessage, { type: "start" }>,
  ) {
    this._pid = child.pid ?? 0;
    child.onMessage((message) => this.handleMessage(message));
    child.onError((error) => this.reportError(error));
    child.onExit((code) => {
      if (!this.exited) this.emitExit(code ?? 1, undefined);
    });
    try {
      child.send(start);
    } catch (error) {
      this.reportError(error);
    }
  }

  get pid(): number {
    return this._pid;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) this.dataListeners.splice(index, 1);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        const index = this.exitListeners.indexOf(listener);
        if (index >= 0) this.exitListeners.splice(index, 1);
      },
    };
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  write(data: string): void {
    this.send({ type: "write", data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  kill(): void {
    if (this._killed || this.exited) return;
    this._killed = true;
    this.send({ type: "kill" });
  }

  private handleMessage(message: ChildMessage): void {
    if (message.type === "ready") {
      this._pid = message.pid ?? this._pid;
    } else if (message.type === "data" && message.data !== undefined) {
      for (const listener of this.dataListeners) listener(message.data);
    } else if (message.type === "error") {
      this.reportError(new Error(message.error || "Windows PTY helper failed"));
    } else if (message.type === "exit") {
      this.emitExit(message.exitCode ?? 1, message.signal);
    }
  }

  private send(message: ParentMessage): void {
    if (this.exited) return;
    try {
      this.child.send(message);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.errorListeners) listener(normalized);
  }

  private emitExit(exitCode: number, signal: number | undefined): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

function createUtilityProcess(helperPath: string): ProcessAdapter | undefined {
  try {
    const electron = electronRequire("electron") as {
      remote?: { require(moduleName: string): { utilityProcess?: UtilityProcessModule } };
    };
    const utilityProcess = electron.remote?.require("electron").utilityProcess;
    if (!utilityProcess) return undefined;

    const child = utilityProcess.fork(helperPath, [], { serviceName: "work-terminal-conpty" });
    return {
      pid: child.pid,
      onMessage: (listener) => child.on("message", listener),
      onError: (listener) => child.on("error", listener),
      onExit: (listener) => child.on("exit", listener),
      send: (message) => child.postMessage(message),
      kill: () => child.kill(),
    };
  } catch {
    return undefined;
  }
}

function createChildProcess(helperPath: string): ProcessAdapter {
  const childProcess = electronRequire("child_process") as {
    fork(modulePath: string, args: string[], options: Record<string, unknown>): ChildProcess;
  };
  const child = childProcess.fork(helperPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    execPath: process.execPath,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  return {
    pid: child.pid,
    onMessage: (listener) => child.on("message", listener),
    onError: (listener) => child.on("error", listener),
    onExit: (listener) => child.on("exit", (code) => listener(code)),
    send: (message) => {
      child.send(message);
    },
    kill: () => {
      child.kill();
    },
  };
}

export function loadBundledNodePty(assetRoot?: string): NodePtyModule {
  const root = ensureWindowsPtyAssets(assetRoot);
  const path = electronRequire("path") as typeof import("path");
  const helperPath = path.join(root, "node-pty-helper.cjs");

  return {
    spawn: (file, args, options) => {
      const child = createUtilityProcess(helperPath) ?? createChildProcess(helperPath);
      return new ForkedNodePtyInstance(child, { type: "start", file, args, options });
    },
  };
}
