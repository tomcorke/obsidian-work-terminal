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

  it("sends Option+B, Option+F, and Option+D as escape sequences", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

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

    const deleteEvent = new KeyboardEvent("keydown", {
      key: "∂",
      code: "KeyD",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(deleteEvent);

    cleanup();

    expect(write).toHaveBeenNthCalledWith(1, "\x1bb");
    expect(write).toHaveBeenNthCalledWith(2, "\x1bf");
    expect(write).toHaveBeenNthCalledWith(3, "\x1bd");
    expect(backwardEvent.defaultPrevented).toBe(true);
    expect(forwardEvent.defaultPrevented).toBe(true);
    expect(deleteEvent.defaultPrevented).toBe(true);
  });

  it("does not intercept Option+digit when key is the raw digit (no composition)", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

    const event = new KeyboardEvent("keydown", {
      key: "3",
      code: "Digit3",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(write).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("intercepts Option+digit on US layout when it produces a composed character (e.g. Option+3 → £)", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

    const event = new KeyboardEvent("keydown", {
      key: "\u00A3",
      code: "Digit3",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(write).toHaveBeenCalledWith("\u00A3");
    expect(event.defaultPrevented).toBe(true);
  });

  it("writes composed Option+digit characters directly to PTY (e.g. UK # via Option+3)", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

    const event = new KeyboardEvent("keydown", {
      key: "#",
      code: "Digit3",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(write).toHaveBeenCalledWith("#");
    expect(event.defaultPrevented).toBe(true);
  });

  it("writes composed Option+digit characters for other layouts (e.g. Euro sign via Option+2)", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

    const event = new KeyboardEvent("keydown", {
      key: "\u20AC",
      code: "Digit2",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(write).toHaveBeenCalledWith("\u20AC");
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not intercept AltGraph-style ctrl+alt combinations", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

    const event = new KeyboardEvent("keydown", {
      key: "∫",
      code: "KeyB",
      altKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(write).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("sends Option+Up and Option+Down as CSI sequences with Alt modifier", () => {
    const write = vi.fn();
    const cleanup = attachCapturePhase(
      containerEl,
      () =>
        ({
          stdin: { destroyed: false, write },
        }) as any,
    );

    const upEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      code: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(upEvent);

    const downEvent = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      code: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(downEvent);

    cleanup();

    expect(write).toHaveBeenNthCalledWith(1, "\x1b[1;3A");
    expect(write).toHaveBeenNthCalledWith(2, "\x1b[1;3B");
    expect(upEvent.defaultPrevented).toBe(true);
    expect(downEvent.defaultPrevented).toBe(true);
  });

  it("does not treat Cmd+Shift+F as plain Cmd+F", () => {
    const onSearch = vi.fn();
    const cleanup = attachCapturePhase(containerEl, () => null, onSearch);

    const event = new KeyboardEvent("keydown", {
      key: "F",
      code: "KeyF",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    cleanup();

    expect(onSearch).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
