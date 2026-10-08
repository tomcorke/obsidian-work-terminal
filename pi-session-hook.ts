import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const target = process.env.WORK_TERMINAL_PI_SESSION_MAP;
  const token = process.env.WORK_TERMINAL_PI_LAUNCH_TOKEN;
  delete process.env.WORK_TERMINAL_PI_SESSION_MAP;
  delete process.env.WORK_TERMINAL_PI_LAUNCH_TOKEN;

  // Timestamp base keeps ordering monotonic if Pi reloads this extension.
  let seq = Date.now() * 1000;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;

  const report = (state: "active" | "idle"): void => {
    if (!target || !token) return;
    const temp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temp,
      JSON.stringify({
        token,
        pid: process.pid,
        sessionId,
        sessionFile,
        state,
        seq: ++seq,
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temp, target);
  };

  // Pi exposes agent_start/agent_end around each agent turn.
  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile();
    report("idle");
  });
  pi.on("agent_start", async () => report("active"));
  pi.on("agent_end", async () => report("idle"));
}
