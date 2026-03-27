/**
 * Spawn a headless (non-interactive) Claude CLI process and capture its output.
 *
 * Used for background operations like generating summaries, extracting context,
 * or running one-shot prompts without a visible terminal.
 */
import { resolveCommand, augmentPath } from "./ClaudeLauncher";
import { expandTilde, electronRequire } from "../utils";

const TIMEOUT_MS = 120_000;

export function spawnHeadlessClaude(
  prompt: string,
  cwd: string,
  claudeCommand = "claude",
  extraArgs = "",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cp = electronRequire("child_process") as typeof import("child_process");

    const resolvedCmd = resolveCommand(claudeCommand);
    const resolvedCwd = expandTilde(cwd);

    const args: string[] = [];

    // Include user-configured extra args (permissions, plugin dirs, etc.)
    if (extraArgs) {
      args.push(...extraArgs.split(/\s+/).filter(Boolean));
    }

    args.push("-p", prompt, "--output-format", "text");

    const proc = cp.spawn(resolvedCmd, args, {
      cwd: resolvedCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: augmentPath(),
        TERM: "dumb",
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    proc.stdout?.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    const timeout = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        proc.kill("SIGTERM");
        resolve({
          exitCode: -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: "Headless Claude timed out after 120s",
        });
      }
    }, TIMEOUT_MS);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error("[work-terminal] Headless Claude error:", err);
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: err.message,
      });
    });

    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    // Close stdin immediately since we pass the prompt via args
    proc.stdin?.end();
  });
}
