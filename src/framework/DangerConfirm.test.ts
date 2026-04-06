// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { DangerConfirm } from "./DangerConfirm";

// Patch HTMLElement with Obsidian-specific DOM helper methods
(function patchObsidianDom() {
  if (!(HTMLElement.prototype as any).empty) {
    (HTMLElement.prototype as any).empty = function () {
      this.innerHTML = "";
    };
  }
  if (!(HTMLElement.prototype as any).createEl) {
    (HTMLElement.prototype as any).createEl = function (
      tag: string,
      opts?: { text?: string; cls?: string },
    ) {
      const el = document.createElement(tag);
      if (opts?.text) el.textContent = opts.text;
      if (opts?.cls) el.className = opts.cls;
      this.appendChild(el);
      return el;
    };
  }
  if (!(HTMLElement.prototype as any).createDiv) {
    (HTMLElement.prototype as any).createDiv = function (opts?: { cls?: string }) {
      const el = document.createElement("div");
      if (opts?.cls) el.className = opts.cls;
      this.appendChild(el);
      return el;
    };
  }
})();

function makeApp() {
  return {
    workspace: {
      on: vi.fn(),
      off: vi.fn(),
    },
  } as any;
}

describe("DangerConfirm", () => {
  it("renders modal content with label", () => {
    const app = makeApp();
    const modal = new DangerConfirm(app, "Delete item", vi.fn());
    modal.onOpen();

    const contentEl = (modal as any).contentEl as HTMLElement;
    const heading = contentEl.querySelector("h3");
    expect(heading?.textContent).toBe("Confirm action");

    const paragraph = contentEl.querySelector("p");
    expect(paragraph?.textContent).toContain("Delete item");
  });

  it("creates cancel and confirm buttons", () => {
    const app = makeApp();
    const modal = new DangerConfirm(app, "Delete item", vi.fn());
    modal.onOpen();

    const contentEl = (modal as any).contentEl as HTMLElement;
    const buttons = contentEl.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe("Cancel");
    expect(buttons[1].textContent).toBe("Confirm");
  });

  it("confirm button has mod-warning class", () => {
    const app = makeApp();
    const modal = new DangerConfirm(app, "Delete item", vi.fn());
    modal.onOpen();

    const contentEl = (modal as any).contentEl as HTMLElement;
    const confirmBtn = contentEl.querySelector(".mod-warning");
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn!.textContent).toBe("Confirm");
  });

  it("calls callback on close after confirm", () => {
    const callback = vi.fn();
    const app = makeApp();
    const modal = new DangerConfirm(app, "Delete item", callback);
    modal.onOpen();

    (modal as any).confirmed = true;
    modal.onClose();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not call callback on close without confirm", () => {
    const callback = vi.fn();
    const app = makeApp();
    const modal = new DangerConfirm(app, "Delete item", callback);
    modal.onOpen();

    modal.onClose();

    expect(callback).not.toHaveBeenCalled();
  });

  describe("static confirm", () => {
    it("executes callback directly", () => {
      const callback = vi.fn();
      DangerConfirm.confirm("Delete item", callback);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
