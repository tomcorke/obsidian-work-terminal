// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachScrollButton } from "./ScrollButton";

describe("attachScrollButton", () => {
  let rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });

  it("updates visibility from scroll events without subscribing to parsed writes", () => {
    const containerEl = document.createElement("div");
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    containerEl.appendChild(viewport);

    const onScroll = vi.fn();
    const onWriteParsed = vi.fn();
    const terminal = {
      buffer: {
        active: {
          viewportY: 0,
          baseY: 5,
        },
      },
      onScroll,
      onWriteParsed,
      scrollToBottom: vi.fn(),
      focus: vi.fn(),
    };

    attachScrollButton(containerEl, terminal as any);
    rafQueue.shift()?.(0);

    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onWriteParsed).not.toHaveBeenCalled();
    expect(containerEl.querySelector(".wt-scroll-bottom")).not.toBeNull();
    expect((containerEl.querySelector(".wt-scroll-bottom") as HTMLButtonElement).style.display).toBe(
      "flex",
    );

    terminal.buffer.active.viewportY = 5;
    const scrollHandler = onScroll.mock.calls[0][0] as () => void;
    scrollHandler();
    rafQueue.shift()?.(0);

    expect((containerEl.querySelector(".wt-scroll-bottom") as HTMLButtonElement).style.display).toBe(
      "none",
    );
  });

  it("scrolls to bottom and focuses when clicked", () => {
    const containerEl = document.createElement("div");
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    containerEl.appendChild(viewport);

    const terminal = {
      buffer: {
        active: {
          viewportY: 0,
          baseY: 5,
        },
      },
      onScroll: vi.fn(),
      onWriteParsed: vi.fn(),
      scrollToBottom: vi.fn(),
      focus: vi.fn(),
    };

    attachScrollButton(containerEl, terminal as any);
    rafQueue.shift()?.(0);
    const button = containerEl.querySelector(".wt-scroll-bottom") as HTMLButtonElement;

    button.click();
    rafQueue.shift()?.(0);

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });
});
