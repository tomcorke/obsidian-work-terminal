import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, writes, renameSync } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  writes: [] as string[],
  renameSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((_path: string, data: string) => writes.push(data)),
    renameSync,
  },
}));

import installHook from "../../../pi-session-hook";

describe("pi-session-hook", () => {
  beforeEach(() => {
    handlers.clear();
    writes.length = 0;
    renameSync.mockClear();
    process.env.WORK_TERMINAL_PI_SESSION_MAP = "/tmp/pi.json";
    process.env.WORK_TERMINAL_PI_LAUNCH_TOKEN = "secret";
  });

  it("registers Pi lifecycle events and atomically writes monotonic transitions", async () => {
    installHook({
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as any);

    expect([...handlers.keys()]).toEqual(["session_start", "agent_start", "agent_end"]);
    await handlers.get("session_start")?.({}, {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => "/tmp/session.jsonl",
      },
    });
    await handlers.get("agent_start")?.();
    await handlers.get("agent_end")?.();

    const reports = writes.map((value) => JSON.parse(value));
    expect(reports).toEqual([
      expect.objectContaining({ state: "idle", sessionId: "session-1" }),
      expect.objectContaining({ state: "active", sessionFile: "/tmp/session.jsonl" }),
      expect.objectContaining({ state: "idle" }),
    ]);
    expect(reports[1].seq).toBe(reports[0].seq + 1);
    expect(reports[2].seq).toBe(reports[1].seq + 1);
    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(renameSync).toHaveBeenLastCalledWith(expect.stringContaining(".tmp"), "/tmp/pi.json");
  });
});
