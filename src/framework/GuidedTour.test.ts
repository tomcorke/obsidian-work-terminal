// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GuidedTourController,
  GUIDED_TOUR_VERSION,
  saveGuidedTourStatus,
  shouldAutoStartGuidedTour,
} from "./GuidedTour";

interface MockSettingManager {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  openTabById: ReturnType<typeof vi.fn>;
}

function setupSettingsDom() {
  const settingsRoot = document.createElement("div");
  settingsRoot.className = "settings-root";

  const claudeArgs = document.createElement("div");
  claudeArgs.setAttribute("data-wt-tour", "core.claudeExtraArgs");
  settingsRoot.appendChild(claudeArgs);

  const additionalContext = document.createElement("div");
  additionalContext.setAttribute("data-wt-tour", "core.additionalAgentContext");
  settingsRoot.appendChild(additionalContext);

  return settingsRoot;
}

function createMockPlugin(initialData: Record<string, unknown> | null = null) {
  let data = initialData;
  let settingsRoot: HTMLElement | null = null;

  const setting: MockSettingManager = {
    open: vi.fn(() => {
      if (!settingsRoot) {
        settingsRoot = setupSettingsDom();
      }
      if (!settingsRoot.isConnected) {
        document.body.appendChild(settingsRoot);
      }
    }),
    close: vi.fn(() => {
      settingsRoot?.remove();
    }),
    openTabById: vi.fn(),
  };

  return {
    app: { setting },
    manifest: { id: "work-terminal" },
    loadData: vi.fn(async () => data),
    saveData: vi.fn(async (next: Record<string, unknown>) => {
      data = next;
    }),
    getData: () => data,
    getSettingManager: () => setting,
    isSettingsOpen: () => !!settingsRoot?.isConnected,
  };
}

async function flushTourUpdates(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await Promise.resolve();
}

describe("GuidedTour", () => {
  const scrollIntoViewMock = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = "";
    scrollIntoViewMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-starts for a fresh user and records an eligibility sentinel", async () => {
    const plugin = createMockPlugin(null);

    await expect(
      shouldAutoStartGuidedTour(plugin as never, { hasExistingItems: false }),
    ).resolves.toBe(true);

    expect(plugin.getData()).toEqual({
      guidedTourEligibility: {
        eligible: true,
        updatedAt: expect.any(String),
      },
    });
  });

  it("does not auto-start for existing users with board items but no saved plugin data", async () => {
    const plugin = createMockPlugin({});

    await expect(
      shouldAutoStartGuidedTour(plugin as never, { hasExistingItems: true }),
    ).resolves.toBe(false);

    expect(plugin.getData()).toEqual({
      guidedTourEligibility: {
        eligible: false,
        updatedAt: expect.any(String),
      },
    });
  });

  it("does not auto-start for existing users with saved plugin data", async () => {
    const plugin = createMockPlugin({ settings: { "core.defaultShell": "/bin/zsh" } });
    await expect(shouldAutoStartGuidedTour(plugin as never)).resolves.toBe(false);
    expect(plugin.getData()).toEqual({
      settings: { "core.defaultShell": "/bin/zsh" },
      guidedTourEligibility: {
        eligible: false,
        updatedAt: expect.any(String),
      },
    });
  });

  it("does not auto-start once the current tour version is recorded", async () => {
    const plugin = createMockPlugin({
      guidedTour: {
        version: GUIDED_TOUR_VERSION,
        status: "completed",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    });
    await expect(shouldAutoStartGuidedTour(plugin as never)).resolves.toBe(false);
  });

  it("auto-starts again when the saved tour version is outdated", async () => {
    const plugin = createMockPlugin({
      guidedTour: {
        version: GUIDED_TOUR_VERSION - 1,
        status: "completed",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    });
    await expect(shouldAutoStartGuidedTour(plugin as never)).resolves.toBe(true);
  });

  it("persists guided tour status without dropping unrelated data", async () => {
    const plugin = createMockPlugin({ settings: { "core.defaultShell": "/bin/zsh" } });
    await saveGuidedTourStatus(plugin as never, "dismissed");
    expect(plugin.getData()).toEqual({
      settings: { "core.defaultShell": "/bin/zsh" },
      guidedTourEligibility: {
        eligible: true,
        updatedAt: expect.any(String),
      },
      guidedTour: {
        version: GUIDED_TOUR_VERSION,
        status: "dismissed",
        updatedAt: expect.any(String),
      },
    });
  });

  it("navigates between board and settings targets in both directions", async () => {
    const plugin = createMockPlugin({});
    const boardTarget = document.createElement("div");
    boardTarget.className = "board-target";
    document.body.appendChild(boardTarget);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Board",
        body: "Board target",
        target: ".board-target",
        surface: "board",
      },
      {
        title: "Settings",
        body: "Settings target",
        target: '[data-wt-tour="core.claudeExtraArgs"]',
        surface: "settings",
      },
      {
        title: "Board again",
        body: "Back to board",
        target: ".board-target",
        surface: "board",
      },
    ]);

    await controller.start();
    expect(boardTarget.classList.contains("wt-tour-target")).toBe(true);
    expect(plugin.getSettingManager().close).toHaveBeenCalledTimes(1);
    expect(plugin.isSettingsOpen()).toBe(false);

    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();

    expect(plugin.getSettingManager().open).toHaveBeenCalledTimes(1);
    expect(plugin.getSettingManager().openTabById).toHaveBeenCalledWith("work-terminal");
    expect(plugin.isSettingsOpen()).toBe(true);
    expect(document.querySelector('[data-wt-tour="core.claudeExtraArgs"]')?.classList.contains("wt-tour-target")).toBe(true);
    expect(boardTarget.classList.contains("wt-tour-target")).toBe(false);

    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();

    expect(plugin.getSettingManager().close).toHaveBeenCalledTimes(2);
    expect(plugin.isSettingsOpen()).toBe(false);
    expect(boardTarget.classList.contains("wt-tour-target")).toBe(true);
  });

  it("only scrolls targets into view when the step changes", async () => {
    const plugin = createMockPlugin({});
    const target = document.createElement("div");
    target.className = "tour-target";
    document.body.appendChild(target);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Welcome",
        body: "Start here",
        target: ".tour-target",
      },
    ]);

    await controller.start();
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await Promise.resolve();

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("ignores in-flight positioning after the tour is disposed", async () => {
    vi.useFakeTimers();
    try {
      const plugin = createMockPlugin({});
      const controller = new GuidedTourController(plugin as never, [
        {
          title: "Missing",
          body: "Wait for a target that never appears",
          target: ".missing-target",
        },
      ]);

      const startPromise = controller.start();
      await Promise.resolve();
      controller.dispose();

      await vi.runAllTimersAsync();
      await expect(startPromise).resolves.toBeUndefined();
      expect(document.querySelector(".wt-tour-card")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a tour step and marks completion when finished", async () => {
    const plugin = createMockPlugin({});
    const target = document.createElement("div");
    target.className = "tour-target";
    document.body.appendChild(target);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Welcome",
        body: "Start here",
        target: ".tour-target",
      },
    ]);

    await controller.start();

    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Welcome");
    expect(target.classList.contains("wt-tour-target")).toBe(true);

    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();

    expect(plugin.getData()).toEqual({
      guidedTourEligibility: {
        eligible: true,
        updatedAt: expect.any(String),
      },
      guidedTour: {
        version: GUIDED_TOUR_VERSION,
        status: "completed",
        updatedAt: expect.any(String),
      },
    });
    expect(document.querySelector(".wt-tour-card")).toBeNull();
  });
});
