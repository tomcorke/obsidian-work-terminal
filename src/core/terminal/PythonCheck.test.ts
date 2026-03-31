import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/AgentLauncher", () => ({
  resolveCommandInfo: vi.fn(),
}));

import { resolveCommandInfo } from "../agents/AgentLauncher";
import {
  checkPython3Available,
  resetPython3Cache,
  hasPython3BeenNotified,
  markPython3Notified,
  PYTHON3_MISSING_MESSAGE,
} from "./PythonCheck";

const mockResolveCommandInfo = vi.mocked(resolveCommandInfo);

describe("PythonCheck", () => {
  afterEach(() => {
    resetPython3Cache();
    vi.clearAllMocks();
  });

  it("returns the resolved path when python3 is found", () => {
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/bin/python3",
      found: true,
    });

    expect(checkPython3Available()).toBe("/usr/bin/python3");
    expect(mockResolveCommandInfo).toHaveBeenCalledWith("python3", undefined, undefined);
  });

  it("returns null when python3 is not found", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "python3",
      found: false,
    });

    expect(checkPython3Available()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[work-terminal] python3 not found on augmented PATH");
    warnSpy.mockRestore();
  });

  it("caches a positive result and does not re-check on subsequent calls", () => {
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/bin/python3",
      found: true,
    });

    expect(checkPython3Available()).toBe("/usr/bin/python3");
    expect(checkPython3Available()).toBe("/usr/bin/python3");
    expect(checkPython3Available()).toBe("/usr/bin/python3");

    expect(mockResolveCommandInfo).toHaveBeenCalledTimes(1);
  });

  it("caches a negative result too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "python3",
      found: false,
    });

    expect(checkPython3Available()).toBeNull();
    expect(checkPython3Available()).toBeNull();
    expect(mockResolveCommandInfo).toHaveBeenCalledTimes(1);
  });

  it("re-checks after resetPython3Cache()", () => {
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "python3",
      found: false,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(checkPython3Available()).toBeNull();
    resetPython3Cache();

    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/local/bin/python3",
      found: true,
    });

    expect(checkPython3Available()).toBe("/usr/local/bin/python3");
    expect(mockResolveCommandInfo).toHaveBeenCalledTimes(2);
  });

  it("passes custom deps through to resolveCommandInfo", () => {
    const fakeDeps = { fs: {} as any, pathModule: {} as any };
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/bin/python3",
      found: true,
    });

    checkPython3Available(fakeDeps);
    expect(mockResolveCommandInfo).toHaveBeenCalledWith("python3", undefined, fakeDeps);
  });

  it("exports a descriptive missing message", () => {
    expect(PYTHON3_MISSING_MESSAGE).toContain("Python 3");
    expect(PYTHON3_MISSING_MESSAGE).toContain("python3");
    expect(PYTHON3_MISSING_MESSAGE).toContain("PATH");
  });

  describe("notification de-duplication", () => {
    it("starts not-notified", () => {
      expect(hasPython3BeenNotified()).toBe(false);
    });

    it("tracks notification state via markPython3Notified()", () => {
      markPython3Notified();
      expect(hasPython3BeenNotified()).toBe(true);
    });

    it("resets notification state along with cache", () => {
      markPython3Notified();
      expect(hasPython3BeenNotified()).toBe(true);
      resetPython3Cache();
      expect(hasPython3BeenNotified()).toBe(false);
    });
  });
});
