import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const target = process.env.WORK_TERMINAL_PI_SESSION_MAP;
  const token = process.env.WORK_TERMINAL_PI_LAUNCH_TOKEN;
  delete process.env.WORK_TERMINAL_PI_SESSION_MAP;
  delete process.env.WORK_TERMINAL_PI_LAUNCH_TOKEN;

  // session_start fires after startup, reload, /new, /resume, and /fork.
  pi.on("session_start", async (_event, ctx) => {
    if (!target || !token) return;

    const temp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temp,
      JSON.stringify({
        token,
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temp, target);
  });
}
