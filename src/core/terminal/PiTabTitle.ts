import type { ChildProcess } from "child_process";
import { resolveCommandInfo, getFullPath, parseExtraArgs } from "../agents/AgentLauncher";
import { electronRequire, stripAnsi } from "../utils";

const MIN_TRANSCRIPT_LENGTH = 200;
const MAX_TRANSCRIPT_LENGTH = 8_000;
const TITLE_TIMEOUT_MS = 30_000;

const TITLE_PROMPT = `Generate a short, stable title for this coding-agent terminal session.
Use 3-6 plain words describing the main task, not the current step.
Return only the title: no quotes, markdown, punctuation, or explanation.

Terminal output:
`;

export function cleanGeneratedTabTitle(output: string): string | null {
  const title = output
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!:;,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.length > 60 || title.split(" ").length > 8) return null;
  return title;
}

export function prepareTabTitleTranscript(output: string): string | null {
  const clean = stripAnsi(output)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (clean.length < MIN_TRANSCRIPT_LENGTH) return null;
  return clean.slice(-MAX_TRANSCRIPT_LENGTH);
}

export async function generateTabTitleWithPi(
  transcript: string,
  cwd: string,
  extraArgs = "",
): Promise<string | null> {
  try {
    const resolution = resolveCommandInfo("pi", cwd);
    if (!resolution.found) return null;

    return await new Promise((resolve) => {
      const cp = electronRequire("child_process") as typeof import("child_process");
      const proc: ChildProcess = cp.spawn(
        resolution.resolved,
        [
          ...parseExtraArgs(extraArgs),
          "--print",
          "--no-session",
          "--no-tools",
          "--no-context-files",
          `${TITLE_PROMPT}${transcript}`,
        ],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PATH: getFullPath(), TERM: "dumb" },
        },
      );

      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (title: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(title);
      };
      proc.stdout?.on("data", (data: Buffer) => chunks.push(data));
      proc.on("error", () => finish(null));
      proc.on("exit", (code) =>
        finish(code === 0 ? cleanGeneratedTabTitle(Buffer.concat(chunks).toString("utf8")) : null),
      );
      const timeout = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL");
          }, 1_000).unref();
        } catch {
          // Process already exited.
        }
        finish(null);
      }, TITLE_TIMEOUT_MS);
    });
  } catch {
    return null;
  }
}
