import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const { resolveCommandInfoMock, spawnMock } = vi.hoisted(() => ({
  resolveCommandInfoMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("../agents/AgentLauncher", () => ({
  resolveCommandInfo: resolveCommandInfoMock,
  getFullPath: () => "/test/bin",
  parseExtraArgs: (value: string) => value.split(" ").filter(Boolean),
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
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
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
    expect(cleanGeneratedTabTitle('"Fix session restore."\nextra')).toBe("Fix session restore");
    expect(cleanGeneratedTabTitle("one two three four five")).toBeNull();
    expect(cleanGeneratedTabTitle("Explore coding agent workflows")).toBeNull();
    expect(cleanGeneratedTabTitle("Fix menu ordering")).toBe("Fix menu ordering");
  });

  it("does not spawn when pi is unavailable", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: false, resolved: "pi" });
    await expect(generateTabTitleWithPi("x".repeat(300), "/repo")).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns null when process startup throws", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: true, resolved: "/test/bin/pi" });
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    await expect(generateTabTitleWithPi("x".repeat(300), "/repo")).resolves.toBeNull();
  });

  it("logs bounded stderr for non-zero exits without repeating terminal output", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: true, resolved: "/test/bin/pi" });
    const proc = processStub();
    spawnMock.mockReturnValue(proc);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transcript = "private terminal output ".repeat(20);
    const result = generateTabTitleWithPi(transcript, "/repo");
    proc.stderr.emit("data", Buffer.from(`provider failed ${transcript}`));
    proc.emit("exit", 1);

    await expect(result).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exited with code 1"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(transcript);
    warn.mockRestore();
  });

  it("retries one content-filter failure", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: true, resolved: "/test/bin/pi" });
    const first = processStub();
    const second = processStub();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = generateTabTitleWithPi("x".repeat(300), "/repo");
    first.stderr.emit("data", Buffer.from("Provider content_filter rejection"));
    first.emit("exit", 1);
    second.stdout.emit("data", Buffer.from("Improve cache skills\n"));
    second.emit("exit", 0);

    await expect(result).resolves.toBe("Improve cache skills");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    info.mockRestore();
    warn.mockRestore();
  });

  it("passes editable arguments before fixed headless safety arguments", async () => {
    resolveCommandInfoMock.mockReturnValue({ found: true, resolved: "/test/bin/pi" });
    const proc = processStub();
    spawnMock.mockReturnValue(proc);
    const result = generateTabTitleWithPi(
      "x".repeat(300),
      "/repo",
      "--model github-copilot/gpt-5.6-luna --thinking off",
    );
    proc.stdout.emit("data", Buffer.from("Fix session restore\n"));
    proc.emit("exit", 0);

    await expect(result).resolves.toBe("Fix session restore");
    expect(spawnMock).toHaveBeenCalledWith(
      "/test/bin/pi",
      expect.arrayContaining([
        "--model",
        "github-copilot/gpt-5.6-luna",
        "--thinking",
        "off",
        "--print",
        "--no-session",
        "--no-tools",
        "--no-context-files",
      ]),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});
