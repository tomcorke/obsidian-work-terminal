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
  const modalContainer = document.createElement("div");
  modalContainer.className = "modal-container";

  const modal = document.createElement("div");
  modal.className = "modal";
  modalContainer.appendChild(modal);

  const settingsRoot = document.createElement("div");
  settingsRoot.className = "settings-root";
  modal.appendChild(settingsRoot);

  const claudeArgs = document.createElement("div");
  claudeArgs.setAttribute("data-wt-tour", "core.claudeExtraArgs");
  settingsRoot.appendChild(claudeArgs);

  const additionalContext = document.createElement("div");
  additionalContext.setAttribute("data-wt-tour", "core.additionalAgentContext");
  settingsRoot.appendChild(additionalContext);

  return modalContainer;
}

function setupDefaultTourBoardDom() {
  const mainView = document.createElement("div");
  mainView.className = "wt-main-view";
  document.body.appendChild(mainView);

  const promptBox = document.createElement("div");
  promptBox.setAttribute("data-wt-tour", "prompt-box");
  const promptToggle = document.createElement("button");
  promptToggle.className = "wt-prompt-toggle";
  promptToggle.textContent = "New task";
  promptBox.appendChild(promptToggle);
  document.body.appendChild(promptBox);

  const listPanel = document.createElement("div");
  listPanel.setAttribute("data-wt-tour", "list-panel");
  document.body.appendChild(listPanel);

  const launchButtons = document.createElement("div");
  launchButtons.setAttribute("data-wt-tour", "launch-buttons");
  const launchButton = document.createElement("button");
  launchButton.textContent = "Launch";
  launchButtons.appendChild(launchButton);
  document.body.appendChild(launchButtons);

  const tabBar = document.createElement("div");
  tabBar.setAttribute("data-wt-tour", "tab-bar");
  document.body.appendChild(tabBar);

  const customSessionButton = document.createElement("button");
  customSessionButton.setAttribute("data-wt-tour", "custom-session-button");
  customSessionButton.textContent = "Custom session";
  document.body.appendChild(customSessionButton);

  return { promptToggle };
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

async function waitFor(assertion: () => boolean, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (assertion()) return;
    await flushTourUpdates();
  }

  throw new Error("Condition was not met in time");
}

async function pressEnterOnButton(button: HTMLButtonElement): Promise<boolean> {
  button.focus();
  const keydown = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(keydown);
  if (!keydown.defaultPrevented) {
    button.click();
  }
  await flushTourUpdates();
  return !keydown.defaultPrevented;
}

async function pressTab(
  target: HTMLElement,
  options: { shiftKey?: boolean } = {},
): Promise<boolean> {
  const keydown = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey === true,
  });
  target.dispatchEvent(keydown);
  await flushTourUpdates();
  return keydown.defaultPrevented;
}

async function clickPrimaryAndWait(): Promise<void> {
  (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
  await flushTourUpdates();
  if (document.querySelector(".wt-tour-card")) {
    await waitFor(
      () => !(document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).disabled,
    );
  }
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
    expect(
      document
        .querySelector('[data-wt-tour="core.claudeExtraArgs"]')
        ?.classList.contains("wt-tour-target"),
    ).toBe(true);
    expect(document.querySelector(".wt-tour-layer")?.parentElement?.className).toBe("modal");
    expect((document.querySelector(".wt-tour-backdrop") as HTMLElement).style.clipPath).toContain(
      "polygon(evenodd",
    );
    expect(boardTarget.classList.contains("wt-tour-target")).toBe(false);
    await waitFor(
      () => !(document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).disabled,
    );

    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();

    expect(plugin.getSettingManager().close).toHaveBeenCalledTimes(2);
    expect(plugin.isSettingsOpen()).toBe(false);
    expect(boardTarget.classList.contains("wt-tour-target")).toBe(true);
  });

  it("ignores rapid next clicks while a board to settings transition is still in flight", async () => {
    let releaseSettingsStep: (() => void) | null = null;
    const settingsStepReady = new Promise<void>((resolve) => {
      releaseSettingsStep = resolve;
    });

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
        beforeShow: () => settingsStepReady,
      },
    ]);

    await controller.start();

    const nextButton = document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement;
    nextButton.click();
    nextButton.click();
    await Promise.resolve();

    expect(nextButton.disabled).toBe(true);
    expect(document.querySelector(".wt-tour-card")?.textContent).not.toContain("Settings");
    expect(plugin.getData()).toEqual({});

    releaseSettingsStep?.();
    await flushTourUpdates();

    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Settings");
    expect(plugin.getData()).toEqual({});
    expect(document.querySelector(".wt-tour-btn-primary")).not.toBeNull();
  });

  it("clamps settings-step cards to the active modal bounds", async () => {
    const plugin = createMockPlugin({});
    plugin.getSettingManager().open();

    const modal = document.querySelector(".modal") as HTMLElement;
    const target = document.querySelector('[data-wt-tour="core.claudeExtraArgs"]') as HTMLElement;

    vi.spyOn(modal, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 40, 360, 300));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(340, 140, 80, 32));

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Settings",
        body: "Stay in bounds",
        target: '[data-wt-tour="core.claudeExtraArgs"]',
        placement: "right",
        surface: "settings",
      },
    ]);

    await controller.start();

    const card = document.querySelector(".wt-tour-card") as HTMLElement;
    expect(card.style.left).toBe("24px");
    expect(card.style.top).toBe("64px");
  });

  it("keeps settings fallback chrome inside the active modal while waiting for a target", async () => {
    vi.useFakeTimers();
    try {
      const plugin = createMockPlugin({});
      plugin.getSettingManager().open();

      const controller = new GuidedTourController(plugin as never, [
        {
          title: "Missing settings target",
          body: "Still scoped to the modal",
          target: ".missing-settings-target",
          surface: "settings",
        },
      ]);

      const startPromise = controller.start();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);

      expect(document.querySelector(".wt-tour-layer")?.parentElement?.className).toBe("modal");

      controller.dispose();
      await vi.runAllTimersAsync();
      await expect(startPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not use keyboard shortcuts while focus is inside an interactive target", async () => {
    const plugin = createMockPlugin({});
    const boardTarget = document.createElement("div");
    boardTarget.className = "board-target";
    document.body.appendChild(boardTarget);

    const promptTextarea = document.createElement("textarea");
    promptTextarea.className = "prompt-target";
    document.body.appendChild(promptTextarea);

    const nextBoardTarget = document.createElement("div");
    nextBoardTarget.className = "board-target-next";
    document.body.appendChild(nextBoardTarget);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Board",
        body: "Board target",
        target: ".board-target",
      },
      {
        title: "Prompt",
        body: "Edit here",
        target: ".prompt-target",
      },
      {
        title: "Next",
        body: "Next board target",
        target: ".board-target-next",
      },
    ]);

    await controller.start();
    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();

    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Prompt");

    promptTextarea.focus();
    promptTextarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    promptTextarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    promptTextarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );
    await flushTourUpdates();

    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Prompt");
  });

  it("does not let global Enter shortcuts override focused tour buttons", async () => {
    const plugin = createMockPlugin({});
    const firstTarget = document.createElement("div");
    firstTarget.className = "tour-target-first";
    document.body.appendChild(firstTarget);

    const secondTarget = document.createElement("div");
    secondTarget.className = "tour-target-second";
    document.body.appendChild(secondTarget);

    const thirdTarget = document.createElement("div");
    thirdTarget.className = "tour-target-third";
    document.body.appendChild(thirdTarget);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "First",
        body: "Start here",
        target: ".tour-target-first",
      },
      {
        title: "Second",
        body: "Middle step",
        target: ".tour-target-second",
      },
      {
        title: "Third",
        body: "Last step",
        target: ".tour-target-third",
      },
    ]);

    await controller.start();
    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();
    await waitFor(
      () => !(document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).disabled,
    );
    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Second");

    const backButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Back",
    ) as HTMLButtonElement;
    expect(await pressEnterOnButton(backButton)).toBe(true);
    await waitFor(() => document.querySelector(".wt-tour-card")?.textContent?.includes("First") ?? false);
    await waitFor(
      () => !(document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).disabled,
    );

    (document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).click();
    await flushTourUpdates();
    await waitFor(
      () => !(document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement).disabled,
    );
    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Second");

    const skipButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Skip",
    ) as HTMLButtonElement;
    expect(await pressEnterOnButton(skipButton)).toBe(true);
    await waitFor(() => document.querySelector(".wt-tour-card") === null);
    expect(plugin.getData()).toEqual({
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
    expect(document.querySelector(".wt-tour-card")).toBeNull();
  });

  it("keeps board-hosted interactive steps inside the tour focus scope", async () => {
    const plugin = createMockPlugin({});
    const boardTarget = document.createElement("textarea");
    boardTarget.className = "board-target";
    document.body.appendChild(boardTarget);

    const unrelatedButton = document.createElement("button");
    unrelatedButton.className = "background-action";
    unrelatedButton.textContent = "Launch session";
    document.body.appendChild(unrelatedButton);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Board",
        body: "Board target",
        target: ".board-target",
        surface: "board",
        allowTargetFocus: true,
      },
    ]);

    await controller.start();

    const card = document.querySelector(".wt-tour-card") as HTMLElement;
    const skipButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Skip",
    ) as HTMLButtonElement;
    const nextButton = document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement;

    expect(document.activeElement).toBe(card);

    expect(await pressTab(card)).toBe(true);
    expect(document.activeElement).toBe(boardTarget);

    boardTarget.focus();
    expect(document.activeElement).toBe(boardTarget);

    expect(await pressTab(boardTarget)).toBe(true);
    expect(document.activeElement).toBe(skipButton);

    expect(await pressTab(skipButton)).toBe(true);
    expect(document.activeElement).toBe(nextButton);

    expect(await pressTab(nextButton, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(skipButton);

    expect(await pressTab(skipButton, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(boardTarget);

    expect(await pressTab(boardTarget, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(nextButton);
    expect(document.activeElement).not.toBe(unrelatedButton);
  });

  it("keeps settings-hosted interactive steps inside the tour focus scope", async () => {
    const plugin = createMockPlugin({});
    plugin.getSettingManager().open();

    const settingsTarget = document.createElement("input");
    settingsTarget.className = "settings-target";
    settingsTarget.type = "text";
    settingsTarget.setAttribute("data-wt-tour", "core.claudeExtraArgsInput");
    (document.querySelector('[data-wt-tour="core.claudeExtraArgs"]') as HTMLElement).appendChild(
      settingsTarget,
    );

    const settingsRoot = document.querySelector(".settings-root") as HTMLElement;
    const unrelatedButton = document.createElement("button");
    unrelatedButton.className = "settings-background-action";
    unrelatedButton.textContent = "Edit setting";
    settingsRoot.appendChild(unrelatedButton);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Settings",
        body: "Settings target",
        target: '[data-wt-tour="core.claudeExtraArgsInput"]',
        surface: "settings",
        allowTargetFocus: true,
      },
    ]);

    await controller.start();

    const card = document.querySelector(".wt-tour-card") as HTMLElement;
    const skipButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Skip",
    ) as HTMLButtonElement;
    const nextButton = document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement;

    expect(document.activeElement).toBe(card);

    expect(await pressTab(card)).toBe(true);
    expect(document.activeElement).toBe(settingsTarget);

    settingsTarget.focus();
    expect(document.activeElement).toBe(settingsTarget);

    expect(await pressTab(settingsTarget)).toBe(true);
    expect(document.activeElement).toBe(skipButton);

    expect(await pressTab(skipButton)).toBe(true);
    expect(document.activeElement).toBe(nextButton);

    expect(await pressTab(nextButton, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(skipButton);

    expect(await pressTab(skipButton, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(settingsTarget);

    expect(await pressTab(settingsTarget, { shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(nextButton);
    expect(document.activeElement).not.toBe(unrelatedButton);
  });

  it("keeps board-hosted container steps trapped on the card by default", async () => {
    const plugin = createMockPlugin({});
    const boardTarget = document.createElement("div");
    boardTarget.className = "board-target";
    const boardControl = document.createElement("button");
    boardControl.className = "board-target-control";
    boardControl.textContent = "Board control";
    boardTarget.appendChild(boardControl);
    document.body.appendChild(boardTarget);

    const unrelatedButton = document.createElement("button");
    unrelatedButton.className = "background-action";
    unrelatedButton.textContent = "Launch session";
    document.body.appendChild(unrelatedButton);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Board",
        body: "Board target",
        target: ".board-target",
        surface: "board",
      },
    ]);

    await controller.start();

    const card = document.querySelector(".wt-tour-card") as HTMLElement;
    const skipButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Skip",
    ) as HTMLButtonElement;
    const nextButton = document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement;

    expect(await pressTab(card)).toBe(true);
    expect(document.activeElement).toBe(skipButton);

    expect(await pressTab(skipButton)).toBe(true);
    expect(document.activeElement).toBe(nextButton);

    boardControl.focus();
    expect(document.activeElement).toBe(skipButton);
    expect(document.activeElement).not.toBe(unrelatedButton);
  });

  it("keeps settings-hosted container steps trapped on the card by default", async () => {
    const plugin = createMockPlugin({});
    plugin.getSettingManager().open();

    const settingsTarget = document.querySelector('[data-wt-tour="core.claudeExtraArgs"]') as HTMLElement;
    const settingsControl = document.createElement("button");
    settingsControl.className = "settings-target-control";
    settingsControl.textContent = "Settings control";
    settingsTarget.appendChild(settingsControl);

    const settingsRoot = document.querySelector(".settings-root") as HTMLElement;
    const unrelatedButton = document.createElement("button");
    unrelatedButton.className = "settings-background-action";
    unrelatedButton.textContent = "Edit setting";
    settingsRoot.appendChild(unrelatedButton);

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Settings",
        body: "Settings target",
        target: '[data-wt-tour="core.claudeExtraArgs"]',
        surface: "settings",
      },
    ]);

    await controller.start();

    const card = document.querySelector(".wt-tour-card") as HTMLElement;
    const skipButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Skip",
    ) as HTMLButtonElement;
    const nextButton = document.querySelector(".wt-tour-btn-primary") as HTMLButtonElement;

    expect(await pressTab(card)).toBe(true);
    expect(document.activeElement).toBe(skipButton);

    expect(await pressTab(skipButton)).toBe(true);
    expect(document.activeElement).toBe(nextButton);

    settingsControl.focus();
    expect(document.activeElement).toBe(skipButton);
    expect(document.activeElement).not.toBe(unrelatedButton);
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

    const card = document.querySelector(".wt-tour-card") as HTMLElement;
    expect(card.textContent).toContain("Welcome");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.hasAttribute("aria-modal")).toBe(false);
    expect(card.getAttribute("aria-labelledby")).toBe("wt-tour-title");
    expect(document.getElementById("wt-tour-title")?.textContent).toBe("Welcome");
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

  it("restores the board surface and focus when finishing the default tour from settings", async () => {
    const plugin = createMockPlugin({});
    const { promptToggle } = setupDefaultTourBoardDom();
    const controller = new GuidedTourController(plugin as never);

    await controller.start();

    for (let index = 0; index < 7; index += 1) {
      await clickPrimaryAndWait();
    }

    expect(document.querySelector(".wt-tour-card")?.textContent).toContain("Save reusable task context");
    expect(plugin.isSettingsOpen()).toBe(true);

    await clickPrimaryAndWait();
    await waitFor(() => document.querySelector(".wt-tour-card") === null);

    expect(plugin.isSettingsOpen()).toBe(false);
    await waitFor(() => document.activeElement === promptToggle);
    expect(document.activeElement).toBe(promptToggle);
  });

  it("restores the board surface and focus when skipping from a settings step", async () => {
    const plugin = createMockPlugin({});
    const { promptToggle } = setupDefaultTourBoardDom();
    const boardTarget = document.querySelector(".wt-main-view") as HTMLElement;

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Board",
        body: "Board target",
        target: ".wt-main-view",
        surface: "board",
      },
      {
        title: "Settings",
        body: "Settings target",
        target: '[data-wt-tour="core.claudeExtraArgs"]',
        surface: "settings",
      },
    ]);

    await controller.start();
    expect(document.activeElement).toBe(document.querySelector(".wt-tour-card"));
    expect(boardTarget.classList.contains("wt-tour-target")).toBe(true);

    await clickPrimaryAndWait();
    expect(plugin.isSettingsOpen()).toBe(true);

    const skipButton = Array.from(document.querySelectorAll(".wt-tour-btn")).find(
      (button) => button.textContent === "Skip",
    ) as HTMLButtonElement;
    skipButton.click();
    await waitFor(() => document.querySelector(".wt-tour-card") === null);

    expect(plugin.isSettingsOpen()).toBe(false);
    await waitFor(() => document.activeElement === promptToggle);
    expect(document.activeElement).toBe(promptToggle);
  });

  it("restores the board surface and focus when escaping from a settings step", async () => {
    const plugin = createMockPlugin({});
    const { promptToggle } = setupDefaultTourBoardDom();

    const controller = new GuidedTourController(plugin as never, [
      {
        title: "Board",
        body: "Board target",
        target: ".wt-main-view",
        surface: "board",
      },
      {
        title: "Settings",
        body: "Settings target",
        target: '[data-wt-tour="core.claudeExtraArgs"]',
        surface: "settings",
      },
    ]);

    await controller.start();
    await clickPrimaryAndWait();
    expect(plugin.isSettingsOpen()).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await waitFor(() => document.querySelector(".wt-tour-card") === null);

    expect(plugin.isSettingsOpen()).toBe(false);
    await waitFor(() => document.activeElement === promptToggle);
    expect(document.activeElement).toBe(promptToggle);
  });
});
