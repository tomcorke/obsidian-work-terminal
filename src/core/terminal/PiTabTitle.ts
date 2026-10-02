import type { ChildProcess } from "child_process";
import { resolveCommandInfo, getFullPath, parseExtraArgs } from "../agents/AgentLauncher";
import { electronRequire, stripAnsi } from "../utils";

const MIN_TRANSCRIPT_LENGTH = 200;
const MAX_TRANSCRIPT_LENGTH = 8_000;
const TITLE_TIMEOUT_MS = 30_000;
const MAX_TITLE_LENGTH = 22;
const MAX_PROCESS_OUTPUT_LENGTH = 8_000;

const TITLE_PROMPT = `Generate a short, stable title for this coding-agent terminal session.
Use 2-4 plain words and at most ${MAX_TITLE_LENGTH} characters including spaces.
Describe the main task, not the current step.
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
  if (!title || title.length > MAX_TITLE_LENGTH || title.split(" ").length > 4) return null;
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
    if (!resolution.found) {
      console.warn("[work-terminal] Automatic tab title skipped: Pi executable unavailable");
      return null;
    }

    const cp = electronRequire("child_process") as typeof import("child_process");
    const run = (retryContentFilter: boolean): Promise<string | null> =>
      new Promise((resolve) => {
        let proc: ChildProcess;
        try {
          proc = cp.spawn(
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
        } catch (error) {
          console.error("[work-terminal] Automatic tab title process failed", error);
          resolve(null);
          return;
        }

        let output = "";
        let errorOutput = "";
        let settled = false;
        const finish = (title: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(title);
        };
        proc.stdout?.on("data", (data: Buffer) => {
          output = (output + data.toString("utf8")).slice(-MAX_PROCESS_OUTPUT_LENGTH);
        });
        proc.stderr?.on("data", (data: Buffer) => {
          errorOutput = (errorOutput + data.toString("utf8")).slice(-MAX_PROCESS_OUTPUT_LENGTH);
        });
        proc.on("error", (error) => {
          console.error("[work-terminal] Automatic tab title process failed", error);
          finish(null);
        });
        proc.on("exit", (code) => {
          if (settled) return;
          const rawError = stripAnsi(errorOutput);
          if (code !== 0) {
            const error = rawError
              .replace(transcript, "[terminal output redacted]")
              .trim()
              .slice(-1_000);
            console.warn(
              `[work-terminal] Automatic tab title process exited with code ${code}${error ? `: ${error}` : ""}`,
            );
            if (retryContentFilter && /content[ _-]?filter|content moderation/i.test(rawError)) {
              settled = true;
              clearTimeout(timeout);
              console.info(
                "[work-terminal] Retrying automatic tab title after content filter error",
              );
              void run(false).then(resolve, () => resolve(null));
              return;
            }
          }
          finish(code === 0 ? cleanGeneratedTabTitle(output) : null);
        });
        const timeout = setTimeout(() => {
          console.warn("[work-terminal] Automatic tab title request timed out");
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
    return await run(true);
  } catch (error) {
    console.error("[work-terminal] Automatic tab title failed to start", error);
    return null;
  }
}
