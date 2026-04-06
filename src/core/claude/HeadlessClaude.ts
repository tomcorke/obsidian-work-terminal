/**
 * Spawn a headless (non-interactive) Claude CLI process and capture its output.
 *
 * Used for background operations like generating summaries, extracting context,
 * or running one-shot prompts without a visible terminal.
 */
import {
  getFullPath,
  buildMissingCliNotice,
  parseExtraArgs,
  resolveCommandInfo,
} from "../agents/AgentLauncher";
import { expandTilde, electronRequire } from "../utils";

/** Default timeout: 5 minutes. Enrichment involves skill loading, duplicate
 *  checks, goal alignment, related-task detection, and file rename - 2 min
 *  was consistently too short (see #327). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Grace period after SIGTERM before sending SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;

export interface HeadlessClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  missingCli?: boolean;
  /** True when the process was killed due to timeout. */
  timedOut?: boolean;
}

export function spawnHeadlessClaude(
  prompt: string,
  cwd: string,
  claudeCommand = "claude",
  extraArgs = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HeadlessClaudeResult> {
  return new Promise((resolve) => {
    const cp = electronRequire("child_process") as typeof import("child_process");
    const resolution = resolveCommandInfo(claudeCommand, cwd);
    if (!resolution.found) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: buildMissingCliNotice("claude", claudeCommand),
        missingCli: true,
      });
      return;
    }
    const resolvedCmd = resolution.resolved;
    const resolvedCwd = expandTilde(cwd);

    const args: string[] = [];

    // Include user-configured extra args (permissions, plugin dirs, etc.)
    if (extraArgs) {
      args.push(...parseExtraArgs(extraArgs));
    }

    args.push("-p", prompt, "--output-format", "text");

    const proc = cp.spawn(resolvedCmd, args, {
      cwd: resolvedCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: getFullPath(),
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

    const timeoutSec = Math.ceil(timeoutMs / 1000);
    const timeout = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        proc.kill("SIGTERM");
        // Escalate to SIGKILL if the process does not exit after SIGTERM.
        // Note: proc.killed is set to true immediately after a successful
        // SIGTERM send, so we check proc.exitCode instead to determine
        // whether the process has actually exited.
        setTimeout(() => {
          try {
            if (proc.exitCode === null) proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, SIGKILL_GRACE_MS);
        resolve({
          exitCode: -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: `Headless Claude timed out after ${timeoutSec}s`,
          timedOut: true,
        });
      }
    }, timeoutMs);

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
