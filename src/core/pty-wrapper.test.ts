import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const PTY_WRAPPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../pty-wrapper.py",
);

/**
 * Spawn pty-wrapper.py with a short-lived command and immediately close stdin.
 * Returns the exit code and whether it exited within the timeout.
 */
function spawnAndCloseStdin(
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [PTY_WRAPPER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut });
    });

    // Close stdin immediately to simulate Obsidian closing the pipe
    proc.stdin.end();
  });
}

async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return Number((await readFile(file, "utf8")).trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Timed out waiting for PTY child PID");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("pty-wrapper.py", () => {
  it("should exit promptly when stdin is closed (not busy-loop)", async () => {
    // Use `cat` as the child command - it reads stdin and exits on EOF.
    // With stdin closed, the wrapper should detect EOF and break the loop.
    const result = await spawnAndCloseStdin(
      ["80", "24", "--", "cat"],
      5000, // 5 second timeout - a busy-loop would hang until killed
    );

    expect(result.timedOut).toBe(false);
    // Process should have exited (any exit code is fine, just not a timeout)
    expect(result.exitCode).not.toBeNull();
  }, 10000);

  it("executes an already-resolved child argv without wrapping it again", async () => {
    const result = await spawnAndCloseStdin(
      ["80", "24", "--resolved", "--", "/usr/bin/true"],
      5000,
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 10000);

  it("terminates the PTY child process group when the wrapper receives SIGTERM", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "work-terminal-pty-"));
    const pidFile = path.join(directory, "child.pid");
    const wrapper = spawn(
      "python3",
      [
        PTY_WRAPPER,
        "80",
        "24",
        "--resolved",
        "--",
        "/bin/sh",
        "-c",
        'echo $$ > "$1"; trap "" TERM; while :; do sleep 1; done',
        "sh",
        pidFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      const childPid = await waitForPid(pidFile);
      const closed = new Promise<void>((resolve) => wrapper.on("close", () => resolve()));
      wrapper.kill("SIGTERM");
      await closed;

      expect(isRunning(childPid)).toBe(false);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);

  it("should exit with child exit code when child terminates", async () => {
    // Spawn `true` which exits with code 0.
    // The wrapper should detect child exit and clean up.
    const result = await spawnAndCloseStdin(["80", "24", "--", "true"], 5000);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 10000);
});
