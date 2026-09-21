import { describe, expect, it, vi } from "vitest";
import {
  createPtyBackend,
  type NodePtyInstance,
  type PtySpawnOptions,
  type TerminalProcess,
} from "./PtyBackend";

const spawnOptions: PtySpawnOptions = {
  shell: "cmd.exe",
  cwd: "C:\\work",
  cols: 90,
  rows: 30,
  command: ["C:\\tools\\agent.exe", "--prompt", "hello world"],
  python3Path: "python3",
  wrapperPath: "pty-wrapper.py",
  env: { PATH: "C:\\Windows\\System32", TERM: "xterm-256color" },
};

function createFakePty(): {
  pty: NodePtyInstance;
  emitData: (data: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
} {
  let dataHandler: ((data: string) => void) | undefined;
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const pty = {
    pid: 1234,
    onData: vi.fn((handler: (data: string) => void) => {
      dataHandler = handler;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((handler: (event: { exitCode: number; signal?: number }) => void) => {
      exitHandler = handler;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  } as unknown as NodePtyInstance;

  return {
    pty,
    emitData: (data) => dataHandler?.(data),
    emitExit: (exitCode, signal) => exitHandler?.({ exitCode, signal }),
  };
}

describe("PtyBackend", () => {
  it("uses node-pty ConPTY on Windows without checking Python", () => {
    const fake = createFakePty();
    const spawn = vi.fn(() => fake.pty);
    const loadNodePty = vi.fn(() => ({ spawn }));
    const backend = createPtyBackend("win32", { loadNodePty });

    const process = backend.spawn(spawnOptions);

    expect(backend.kind).toBe("conpty");
    expect(loadNodePty).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith("C:\\tools\\agent.exe", ["--prompt", "hello world"], {
      name: "xterm-256color",
      cols: 90,
      rows: 30,
      cwd: "C:\\work",
      env: spawnOptions.env,
      useConpty: true,
      useConptyDll: true,
    });
    expect(process.pid).toBe(1234);
  });

  it("runs Windows command shims through ComSpec", () => {
    const fake = createFakePty();
    const spawn = vi.fn(() => fake.pty);
    const backend = createPtyBackend("win32", { loadNodePty: () => ({ spawn }) });

    backend.spawn({
      ...spawnOptions,
      env: { ...spawnOptions.env, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      command: ["C:\\Program Files\\tool.cmd", "--flag", "hello world"],
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      '/d /c ""C:\\Program Files\\tool.cmd" --flag "hello world""',
      expect.anything(),
    );
  });

  it("maps ConPTY input, output, resize, exit, and cleanup to one process interface", () => {
    const fake = createFakePty();
    const backend = createPtyBackend("win32", {
      loadNodePty: () => ({ spawn: () => fake.pty }),
    });
    const process = backend.spawn(spawnOptions);
    const output = vi.fn();
    const exit = vi.fn();
    process.onData(output);
    process.onExit(exit);

    process.stdin.write("dir\r");
    process.resize(100, 40);
    process.kill();
    fake.emitData("output");
    fake.emitExit(0);

    expect(fake.pty.write).toHaveBeenCalledWith("dir\r");
    expect(fake.pty.resize).toHaveBeenCalledWith(100, 40);
    expect(fake.pty.kill).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("output");
    expect(exit).toHaveBeenCalledWith(0, null);
    expect(process.exitCode).toBe(0);
    expect(process.stdin.destroyed).toBe(true);
  });

  it("reports ConPTY write failures through the shared error surface", () => {
    const fake = createFakePty();
    vi.spyOn(fake.pty, "write").mockImplementation(() => {
      throw new Error("write failed");
    });
    const backend = createPtyBackend("win32", { loadNodePty: () => ({ spawn: () => fake.pty }) });
    const process = backend.spawn(spawnOptions);
    const error = vi.fn();
    process.onError(error);

    process.stdin.write("input");

    expect(error).toHaveBeenCalledWith(new Error("write failed"));
  });

  it("keeps POSIX launches on the Python wrapper backend", () => {
    const child = {
      stdin: { write: vi.fn(), destroyed: false },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      pid: 5678,
      killed: false,
      exitCode: null,
      signalCode: null,
    };
    const spawnChild = vi.fn(() => child);
    const backend = createPtyBackend("linux", { spawnChild });

    const process = backend.spawn({
      ...spawnOptions,
      shell: "/bin/zsh",
      cwd: "/work",
      command: ["/bin/zsh", "-i"],
      python3Path: "/usr/bin/python3",
      wrapperPath: "/plugin/pty-wrapper.py",
    });

    expect(backend.kind).toBe("python");
    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/python3",
      ["/plugin/pty-wrapper.py", "90", "30", "--resolved", "--", "/bin/zsh", "-i"],
      expect.objectContaining({ cwd: "/work", stdio: ["pipe", "pipe", "pipe"] }),
    );

    process.resize(100, 40);
    expect(child.stdin.write).toHaveBeenCalledWith("\x1b]777;resize;100;40\x07");
  });

  it("rejects a Windows backend when its native loader is unavailable", () => {
    const backend = createPtyBackend("win32", {
      loadNodePty: () => {
        throw new Error("module missing");
      },
    });

    expect(() => backend.spawn(spawnOptions)).toThrow(/native Windows terminal backend/i);
  });

  it("exposes process interface as the backend seam", () => {
    const fake = createFakePty();
    const backend = createPtyBackend("win32", {
      loadNodePty: () => ({ spawn: () => fake.pty }),
    });

    const process: TerminalProcess = backend.spawn(spawnOptions);
    expect(typeof process.stdin.write).toBe("function");
    expect(typeof process.onData).toBe("function");
    expect(typeof process.onError).toBe("function");
    expect(typeof process.onExit).toBe("function");
    expect(typeof process.resize).toBe("function");
    expect(typeof process.kill).toBe("function");
  });
});
