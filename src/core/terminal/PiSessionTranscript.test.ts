import { beforeEach, describe, expect, it, vi } from "vitest";

const { files, rmSync, kill } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  rmSync: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("../utils", () => ({
  electronRequire: (name: string) =>
    name === "path"
      ? { join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/") }
      : {
          readFileSync: (path: string) => {
            const value = files.get(path);
            if (value === undefined) throw new Error("missing");
            return value;
          },
          rmSync,
          readdirSync: () => ["alive.json", "dead.json"],
          statSync: (path: string) => ({ size: Buffer.byteLength(files.get(path) ?? "") }),
          openSync: (path: string) => path,
          readSync: (
            path: string,
            buffer: Buffer,
            _offset: number,
            length: number,
            position: number,
          ) => {
            buffer.write((files.get(path) ?? "").slice(position, position + length));
            return length;
          },
          closeSync: () => undefined,
        },
}));

import {
  acceptPiLifecycleReport,
  parsePiSessionTranscript,
  prunePiSessionMappings,
  readPiLifecycleReport,
  readPiSessionTranscript,
} from "./PiSessionTranscript";

describe("PiSessionTranscript", () => {
  beforeEach(() => {
    files.clear();
    rmSync.mockClear();
    kill.mockReset();
    kill.mockImplementation(() => true);
    vi.spyOn(process, "kill").mockImplementation(kill);
  });

  it("reads only user and assistant text from the active branch", () => {
    const lines = [
      { type: "session", id: "session" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Fix titles" }] },
      },
      {
        type: "message",
        id: "old",
        parentId: "u1",
        message: { role: "assistant", content: "abandoned branch" },
      },
      {
        type: "message",
        id: "tool",
        parentId: "u1",
        message: { role: "toolResult", content: [{ type: "text", text: "secret output" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "tool",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Implemented mapping" }, { type: "toolCall" }],
        },
      },
    ];

    expect(
      parsePiSessionTranscript(lines.map((line) => JSON.stringify(line)).join("\n") + "\n{"),
    ).toBe("User: Fix titles\nAssistant: Implemented mapping");
  });

  it("rejects mismatched and dead mappings", () => {
    files.set(
      "map",
      JSON.stringify({
        token: "other",
        pid: 42,
        sessionId: "s",
        sessionFile: "log",
        updatedAt: Date.now(),
      }),
    );
    expect(readPiSessionTranscript("map", "expected")).toBeNull();

    files.set(
      "map",
      JSON.stringify({
        token: "expected",
        pid: 42,
        sessionId: "s",
        sessionFile: "log",
        updatedAt: Date.now(),
      }),
    );
    kill.mockImplementation(() => {
      const error = new Error() as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    expect(readPiSessionTranscript("map", "expected")).toBeNull();
  });

  it("accepts only live, token-bound lifecycle reports with safe sequences", () => {
    files.set(
      "map",
      JSON.stringify({ token: "token", pid: 42, state: "active", seq: 3, updatedAt: Date.now() }),
    );
    expect(readPiLifecycleReport("map", "token")).toEqual({ state: "active", seq: 3 });

    for (const invalid of [
      { token: "other", pid: 42, state: "idle", seq: 4 },
      { token: "token", pid: 42, state: "waiting", seq: 4 },
      { token: "token", pid: 42, state: "idle", seq: -1 },
      { token: "token", pid: 42, state: "idle", seq: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      files.set("map", JSON.stringify(invalid));
      expect(readPiLifecycleReport("map", "token")).toBeNull();
    }
  });

  it("retains authority for absent or stale reports and accepts newer sequences", () => {
    const accepted = acceptPiLifecycleReport(
      { accepted: false, seq: -1 },
      { state: "active", seq: 2 },
    );
    expect(acceptPiLifecycleReport(accepted, null)).toBe(accepted);
    expect(acceptPiLifecycleReport(accepted, { state: "idle", seq: 2 })).toBe(accepted);
    expect(acceptPiLifecycleReport(accepted, { state: "idle", seq: 1 })).toBe(accepted);
    expect(acceptPiLifecycleReport(accepted, { state: "idle", seq: 3 })).toEqual({
      accepted: true,
      state: "idle",
      seq: 3,
    });
  });

  it("rejects lifecycle reports from dead processes", () => {
    files.set("map", JSON.stringify({ token: "token", pid: 42, state: "idle", seq: 1 }));
    kill.mockImplementation(() => {
      const error = new Error() as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    expect(readPiLifecycleReport("map", "token")).toBeNull();
  });

  it("prunes mappings for processes that no longer exist", () => {
    files.set("/maps/alive.json", JSON.stringify({ pid: 1, updatedAt: Date.now() }));
    files.set("/maps/dead.json", JSON.stringify({ pid: 2, updatedAt: Date.now() }));
    kill.mockImplementation((pid: number) => {
      if (pid === 2) {
        const error = new Error() as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });

    prunePiSessionMappings("/maps");
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledWith("/maps/dead.json", { force: true });
  });

  it("loads the mapped session while its process is alive", () => {
    files.set(
      "map",
      JSON.stringify({
        token: "token",
        pid: 42,
        sessionId: "s",
        sessionFile: "log",
        updatedAt: Date.now(),
      }),
    );
    files.set(
      "log",
      JSON.stringify({
        type: "message",
        id: "u",
        parentId: null,
        message: { role: "user", content: "Current task context" },
      }),
    );
    expect(readPiSessionTranscript("map", "token")).toBe("User: Current task context");
    expect(kill).toHaveBeenCalledWith(42, 0);
  });
});
