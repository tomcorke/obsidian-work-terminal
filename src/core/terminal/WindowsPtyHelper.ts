import { spawn, type IPty } from "node-pty";

type StartMessage = {
  type: "start";
  file: string;
  args: string[] | string;
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
    useConpty: boolean;
    useConptyDll: boolean;
  };
};

type ParentMessage =
  | StartMessage
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" };

type ParentPort = {
  on(event: "message", listener: (event: { data: ParentMessage }) => void): void;
  postMessage(message: Record<string, unknown>): void;
};

const parentPort = (process as typeof process & { parentPort?: ParentPort }).parentPort;
let pty: IPty | undefined;

function send(message: Record<string, unknown>): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function start(message: StartMessage): void {
  try {
    pty = spawn(message.file, message.args, message.options);
    send({ type: "ready", pid: pty.pid });
    pty.onData((data) => send({ type: "data", data }));
    pty.onExit(({ exitCode, signal }) => {
      send({ type: "exit", exitCode, signal });
      setImmediate(() => process.exit(exitCode));
    });
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : String(error) });
    setImmediate(() => process.exit(1));
  }
}

function handleMessage(message: ParentMessage): void {
  if (message.type === "start") {
    if (!pty) start(message);
    return;
  }
  if (!pty) return;

  try {
    if (message.type === "write") pty.write(message.data);
    else if (message.type === "resize") pty.resize(message.cols, message.rows);
    else pty.kill();
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

if (parentPort) {
  parentPort.on("message", (event) => handleMessage(event.data));
} else {
  process.on("message", handleMessage);
}
