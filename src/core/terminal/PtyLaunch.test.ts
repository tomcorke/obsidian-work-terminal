import { describe, expect, it } from "vitest";
import { buildPtyLaunchPlan, quoteShellArg } from "./PtyLaunch";

describe("PTY launch planning", () => {
  it("builds the exact Python wrapper and fully quoted login-shell argv", () => {
    const plan = buildPtyLaunchPlan({
      python3Path: "/usr/bin/python3",
      wrapperPath: "/plugin/pty-wrapper.py",
      cols: 101,
      rows: 37,
      command: ["opencode", "--prompt", "line 1\nline '2' with \\\"quotes\\\""],
      loginShellWrap: true,
      shell: "/bin/zsh",
    });

    expect(plan.child.argv).toEqual([
      "/bin/zsh",
      "-l",
      "-i",
      "-c",
      `opencode --prompt 'line 1\nline '"'"'2'"'"' with \\"quotes\\"'`,
    ]);
    expect(plan.python.argv).toEqual([
      "/usr/bin/python3",
      "/plugin/pty-wrapper.py",
      "101",
      "37",
      "--resolved",
      "--",
      ...plan.child.argv,
    ]);
  });

  it("executes absolute commands and interactive shells directly", () => {
    expect(
      buildPtyLaunchPlan({
        python3Path: "python3",
        wrapperPath: "pty-wrapper.py",
        cols: 80,
        rows: 24,
        command: ["/usr/local/bin/opencode", "--help"],
      }).child.argv,
    ).toEqual(["/usr/local/bin/opencode", "--help"]);

    expect(
      buildPtyLaunchPlan({
        python3Path: "python3",
        wrapperPath: "pty-wrapper.py",
        cols: 80,
        rows: 24,
        command: ["/bin/zsh", "-i"],
        loginShellWrap: true,
      }).child.argv,
    ).toEqual(["/bin/zsh", "-i"]);
  });

  it("matches shlex.quote boundaries for empty, safe, and quoted values", () => {
    expect(quoteShellArg("")).toBe("''");
    expect(quoteShellArg("--safe=value/path")).toBe("--safe=value/path");
    expect(quoteShellArg("it's spaced")).toBe(`'it'"'"'s spaced'`);
  });
});
