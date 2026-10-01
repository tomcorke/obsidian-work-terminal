import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { resolveCommandInfoMock, spawnMock } = vi.hoisted(() => ({
  resolveCommandInfoMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("../agents/AgentLauncher", () => ({
  resolveCommandInfo: resolveCommandInfoMock,
  getFullPath: () => "/test/bin",
}));
vi.mock("../utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../utils")>();
  return {
    ...original,
    electronRequire: () => ({ spawn: spawnMock }),
  };
});

import {
  cleanGeneratedTabTitle,
  generateTabTitleWithPi,
  prepareTabTitleTranscript,
} from "./PiTabTitle";

function processStub() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe("PiTabTitle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for meaningful output and bounds the transcript", () => {
    expect(prepareTabTitleTranscript("short output")).toBeNull();
    const transcript = prepareTabTitleTranscript(
      `\u001b[31m${"useful output ".repeat(800)}\u001b[0m`,
    );
    expect(transcript).not.toContain("\u001b");
    expect(transcript!.length).toBeLessThanOrEqual(8_000);
  });

  it("rejects verbose titles and normalizes a short title", () => {
    expect(cleanGeneratedTabTitle('"Investigate session restore."\nextra')).toBe(
      "Investigate session restore",
    );
    expect(cleanGeneratedTabTitle("one two three four five six seven eight nine")).toBeNull();
  });

  it("does not spawn when pi is unavailable", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: false, resolved: "pi" });
    await expect(generateTabTitleWithPi("x".repeat(300), "/repo")).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("invokes pi directly in cheap headless mode", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: true, resolved: "/test/bin/pi" });
    const proc = processStub();
    spawnMock.mockReturnValue(proc);
    const result = generateTabTitleWithPi("x".repeat(300), "/repo");
    proc.stdout.emit("data", Buffer.from("Fix session restore\n"));
    proc.emit("exit", 0);

    await expect(result).resolves.toBe("Fix session restore");
    expect(spawnMock).toHaveBeenCalledWith(
      "/test/bin/pi",
      expect.arrayContaining([
        "--model",
        "portkey/gpt-5.6-luna",
        "--thinking",
        "low",
        "--print",
        "--no-session",
        "--no-tools",
        "--no-context-files",
      ]),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});
