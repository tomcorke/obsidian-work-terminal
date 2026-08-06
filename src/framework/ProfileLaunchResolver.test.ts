import { describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../core/agents/AgentProfile";
import { buildPtyLaunchPlan } from "../core/terminal/PtyLaunch";
import {
  PROFILE_PREVIEW_EXAMPLE_ABSOLUTE_PATH,
  PROFILE_PREVIEW_EXAMPLE_ITEM,
  PROFILE_PREVIEW_EXAMPLE_SESSION_ID,
  formatProfileLaunchPreview,
  resolveProfileLaunch,
} from "./ProfileLaunchResolver";

const baseProfile: AgentProfile = {
  id: "profile-1",
  name: "OpenCode custom",
  agentType: "custom",
  command: "/bin/echo",
  defaultCwd: "~",
  arguments: "--global --task $title",
  contextPrompt: "Review $absoluteFilePath\nKeep both 'quotes' and \"quotes\".",
  useContext: true,
  suppressAdapterPrompt: false,
  button: { enabled: false, label: "" },
  sortOrder: 0,
};

const manager = {
  resolveCommand: (profile: AgentProfile) => profile.command,
  resolveCwd: (profile: AgentProfile) => profile.defaultCwd,
  resolveArguments: (profile: AgentProfile) => profile.arguments,
  resolveContextPrompt: (profile: AgentProfile) => profile.contextPrompt,
} as any;

const promptBuilder = {
  buildPrompt: (item: typeof PROFILE_PREVIEW_EXAMPLE_ITEM, fullPath: string) =>
    `Task: ${item.title}\nFile: ${fullPath}`,
};

describe("profile launch resolution and preview", () => {
  it("assembles placeholders, context, positional prompt, and exact argv once", () => {
    const resolved = resolveProfileLaunch({
      profile: baseProfile,
      settings: {},
      profileManager: manager,
      promptBuilder,
      item: PROFILE_PREVIEW_EXAMPLE_ITEM,
      absoluteFilePath: PROFILE_PREVIEW_EXAMPLE_ABSOLUTE_PATH,
      sessionId: PROFILE_PREVIEW_EXAMPLE_SESSION_ID,
      sourceLabel: "example values",
    });

    expect(resolved.prompt).toContain("Task: [example task title]");
    expect(resolved.prompt).toContain("Keep both 'quotes' and \"quotes\".");
    expect(resolved.invocation.args.slice(0, 3)).toEqual(["--global", "--task", "[example"]);
    expect(resolved.invocation.args.at(-1)).toBe(resolved.prompt);
    expect(resolved.invocation.argv[0]).toBe("/bin/echo");

    const preview = formatProfileLaunchPreview(resolved);
    expect(preview).toContain("Prompt placement: positional");
    expect(preview).toContain("\\n");
    expect(preview).toContain("argv[");
    expect(preview).not.toContain("Clearly");
  });

  it("shows flag placement and the login-shell layer without losing prompt boundaries", () => {
    const resolved = resolveProfileLaunch({
      profile: {
        ...baseProfile,
        promptInjectionMode: "flag",
        promptFlag: "--prompt",
        loginShellWrap: true,
      },
      settings: {},
      profileManager: manager,
      promptBuilder,
      item: PROFILE_PREVIEW_EXAMPLE_ITEM,
      absoluteFilePath: PROFILE_PREVIEW_EXAMPLE_ABSOLUTE_PATH,
    });

    expect(resolved.invocation.argv.slice(-2)).toEqual(["--prompt", resolved.prompt]);
    const preview = formatProfileLaunchPreview(resolved);
    expect(preview).toContain('Prompt placement: flag "--prompt"');
    expect(preview).toContain("PTY Python wrapper layer:");
    expect(preview).toContain("Login-shell child layer:");
    expect(preview).toContain('argv[4]: "/bin/echo --global');
  });

  it("uses the supplied manager resolution path for global/profile merging", () => {
    const resolveArguments = vi.fn(() => "--global --profile");
    const resolved = resolveProfileLaunch({
      profile: { ...baseProfile, useContext: false },
      settings: { "core.claudeExtraArgs": "--global" },
      profileManager: { ...manager, resolveArguments } as any,
      promptBuilder,
      item: PROFILE_PREVIEW_EXAMPLE_ITEM,
    });

    expect(resolveArguments).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
    expect(resolved.invocation.args).toEqual(["--global", "--profile"]);
    expect(formatProfileLaunchPreview(resolved)).toContain("Prompt placement: not injected");
  });

  it("keeps shell profiles interactive and never passes context as a script", () => {
    const buildPrompt = vi.fn(() => "must not become a shell script");
    const resolved = resolveProfileLaunch({
      profile: { ...baseProfile, agentType: "shell", useContext: true, arguments: "" },
      settings: {},
      profileManager: manager,
      promptBuilder: { buildPrompt },
      item: PROFILE_PREVIEW_EXAMPLE_ITEM,
    });

    expect(buildPrompt).not.toHaveBeenCalled();
    expect(resolved.prompt).toBeUndefined();
    expect(resolved.invocation.argv).toEqual(["/bin/echo", "-i"]);
    expect(resolved.error).toBeUndefined();
  });

  it("uses the exact PTY plan consumed by TerminalTab in its formatted preview", () => {
    const resolved = resolveProfileLaunch({
      profile: {
        ...baseProfile,
        command: "pi",
        loginShellWrap: true,
        useContext: false,
        arguments: "--message 'both quotes: \\\" and single'",
      },
      settings: {},
      profileManager: manager,
      promptBuilder,
      item: PROFILE_PREVIEW_EXAMPLE_ITEM,
      pty: {
        python3Path: "/usr/bin/python3",
        wrapperPath: "/plugin/pty-wrapper.py",
        cols: 101,
        rows: 37,
        shell: "/bin/zsh",
      },
    });

    expect(resolved.pty).toEqual(
      buildPtyLaunchPlan({
        python3Path: "/usr/bin/python3",
        wrapperPath: "/plugin/pty-wrapper.py",
        cols: 101,
        rows: 37,
        command: resolved.invocation.argv,
        loginShellWrap: true,
        shell: "/bin/zsh",
      }),
    );
    const preview = formatProfileLaunchPreview(resolved);
    resolved.pty.python.argv.forEach((arg, index) => {
      expect(preview).toContain(`argv[${index}]: ${JSON.stringify(arg)}`);
    });
    expect(preview).not.toContain("<shell-quoted");
  });
});
