// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GuidedTourController,
  GUIDED_TOUR_VERSION,
  saveGuidedTourStatus,
  shouldAutoStartGuidedTour,
} from "./GuidedTour";

function createMockPlugin(initialData: Record<string, unknown> | null = null) {
  let data = initialData;
  return {
    app: { setting: { open: vi.fn(), openTabById: vi.fn() } },
    manifest: { id: "work-terminal" },
    loadData: vi.fn(async () => data),
    saveData: vi.fn(async (next: Record<string, unknown>) => {
      data = next;
    }),
    getData: () => data,
  };
}

describe("GuidedTour", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("auto-starts when plugin data does not exist yet", async () => {
    const plugin = createMockPlugin(null);
    await expect(shouldAutoStartGuidedTour(plugin as never)).resolves.toBe(true);
  });

  it("auto-starts when plugin data exists but is still empty", async () => {
    const plugin = createMockPlugin({});
    await expect(shouldAutoStartGuidedTour(plugin as never)).resolves.toBe(true);
  });

  it("does not auto-start for existing users with saved plugin data", async () => {
    const plugin = createMockPlugin({ settings: { "core.defaultShell": "/bin/zsh" } });
    await expect(shouldAutoStartGuidedTour(plugin as never)).resolves.toBe(false);
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
      guidedTour: {
        version: GUIDED_TOUR_VERSION,
        status: "dismissed",
        updatedAt: expect.any(String),
      },
    });
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(plugin.getData()).toEqual({
      guidedTour: {
        version: GUIDED_TOUR_VERSION,
        status: "completed",
        updatedAt: expect.any(String),
      },
    });
    expect(document.querySelector(".wt-tour-card")).toBeNull();
  });
});
