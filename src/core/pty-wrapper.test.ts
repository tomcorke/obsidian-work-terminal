import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
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

  it("should exit with child exit code when child terminates", async () => {
    // Spawn `true` which exits with code 0.
    // The wrapper should detect child exit and clean up.
    const result = await spawnAndCloseStdin(["80", "24", "--", "true"], 5000);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 10000);
});
