import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/AgentLauncher", () => ({
  resolveCommandInfo: vi.fn(),
}));

import { resolveCommandInfo } from "../agents/AgentLauncher";
import {
  checkPython3Available,
  resetPython3Cache,
  PYTHON3_MISSING_MESSAGE,
} from "./PythonCheck";

const mockResolveCommandInfo = vi.mocked(resolveCommandInfo);

describe("PythonCheck", () => {
  afterEach(() => {
    resetPython3Cache();
    vi.clearAllMocks();
  });

  it("returns true when python3 is found on PATH", () => {
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/bin/python3",
      found: true,
    });

    expect(checkPython3Available()).toBe(true);
    expect(mockResolveCommandInfo).toHaveBeenCalledWith("python3", undefined, undefined);
  });

  it("returns false when python3 is not found", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "python3",
      found: false,
    });

    expect(checkPython3Available()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith("[work-terminal] python3 not found on PATH");
    warnSpy.mockRestore();
  });

  it("caches the result and does not re-check on subsequent calls", () => {
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/bin/python3",
      found: true,
    });

    checkPython3Available();
    checkPython3Available();
    checkPython3Available();

    expect(mockResolveCommandInfo).toHaveBeenCalledTimes(1);
  });

  it("caches a negative result too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "python3",
      found: false,
    });

    expect(checkPython3Available()).toBe(false);
    expect(checkPython3Available()).toBe(false);
    expect(mockResolveCommandInfo).toHaveBeenCalledTimes(1);
  });

  it("re-checks after resetPython3Cache()", () => {
    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "python3",
      found: false,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(checkPython3Available()).toBe(false);
    resetPython3Cache();

    mockResolveCommandInfo.mockReturnValue({
      requested: "python3",
      resolved: "/usr/local/bin/python3",
      found: true,
    });

    expect(checkPython3Available()).toBe(true);
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
});
