// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCapturePhase } from "./KeyboardCapture";

describe("KeyboardCapture", () => {
  let containerEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    containerEl = document.createElement("div");
    textareaEl = document.createElement("textarea");
    textareaEl.className = "xterm-helper-textarea";
    containerEl.appendChild(textareaEl);
    document.body.appendChild(containerEl);

    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => textareaEl,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("sends Option+B and Option+F as word-navigation escape sequences", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(containerEl, () => ({
      stdin: { destroyed: false, write },
    }) as any);

    const backwardEvent = new KeyboardEvent("keydown", {
      key: "∫",
      code: "KeyB",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(backwardEvent);

    const forwardEvent = new KeyboardEvent("keydown", {
      key: "ƒ",
      code: "KeyF",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(forwardEvent);

    cleanup();

    expect(write).toHaveBeenNthCalledWith(1, "\x1bb");
    expect(write).toHaveBeenNthCalledWith(2, "\x1bf");
    expect(backwardEvent.defaultPrevented).toBe(true);
    expect(forwardEvent.defaultPrevented).toBe(true);
  });

  it("does not intercept printable Option+digit combinations", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(containerEl, () => ({
      stdin: { destroyed: false, write },
    }) as any);

    const event = new KeyboardEvent("keydown", {
      key: "3",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(write).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
