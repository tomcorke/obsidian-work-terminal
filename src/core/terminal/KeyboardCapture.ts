/**
 * Two-layer keyboard interception for xterm.js in Obsidian.
 *
 * Layer 1 (bubble phase): stopPropagation on the container element to prevent
 * Obsidian's bubble-phase handlers from intercepting keyboard events after
 * xterm processes them.
 *
 * Layer 2 (capture phase): intercept specific modifier combos on document
 * (capture phase) before Obsidian sees them. Synthesizes terminal escape
 * sequences directly to PTY stdin, then kills the event entirely.
 */
import type { ChildProcess } from "child_process";

/**
 * Attach bubble-phase keyboard interception on a container element.
 * Prevents Obsidian from receiving keydown/keyup events that bubble up
 * from the terminal.
 */
export function attachBubbleCapture(containerEl: HTMLElement): void {
  containerEl.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      e.stopPropagation();
    },
    false,
  );
  containerEl.addEventListener(
    "keyup",
    (e: KeyboardEvent) => {
      e.stopPropagation();
    },
    false,
  );
}

/**
 * Attach capture-phase keyboard interception on document for modifier combos
 * that Obsidian steals in its own capture-phase handlers.
 *
 * Only acts when the terminal's hidden textarea is the active element,
 * ensuring we don't block keyboard events for other UI elements.
 *
 * @returns A cleanup function that removes the document listener.
 */
export function attachCapturePhase(
  containerEl: HTMLElement,
  getProcess: () => ChildProcess | null,
  onSearch?: () => void,
): () => void {
  const textareaEl = containerEl.querySelector(
    ".xterm-helper-textarea",
  ) as HTMLTextAreaElement | null;

  const handler = (e: KeyboardEvent) => {
    if (!textareaEl || document.activeElement !== textareaEl) return;

    // Cmd+F: toggle search bar (intercept before Obsidian's find)
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyF" && onSearch) {
      e.stopImmediatePropagation();
      e.preventDefault();
      onSearch();
      return;
    }

    const normalizedKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let seq: string | null = null;
    const isAltGraph = e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey);

    if (e.key === "Enter" && e.shiftKey) {
      // Shift+Enter: CSI u encoding so Claude CLI sees it as distinct from Enter
      seq = "\x1b[13;2u";
    } else if (e.altKey && e.key === "ArrowLeft") {
      // ESC b - word backward
      seq = "\x1bb";
    } else if (e.altKey && e.key === "ArrowRight") {
      // ESC f - word forward
      seq = "\x1bf";
    } else if (e.altKey && e.key === "Backspace") {
      // ESC DEL - delete word backward
      seq = "\x1b\x7f";
    } else if (!isAltGraph && e.altKey && e.code === "KeyB") {
      // ESC b - word backward without enabling xterm macOptionIsMeta,
      // which blocks composed Option+digit characters on non-US layouts.
      seq = "\x1bb";
    } else if (!isAltGraph && e.altKey && e.code === "KeyF") {
      // ESC f - word forward without hijacking printable Option combos.
      seq = "\x1bf";
    } else if (!isAltGraph && e.altKey && e.code === "KeyD") {
      // ESC d - delete word forward
      seq = "\x1bd";
    } else if (e.metaKey && normalizedKey === "ArrowLeft") {
      // Cmd+Left: beginning of line (Ctrl-A)
      seq = "\x01";
    } else if (e.metaKey && normalizedKey === "ArrowRight") {
      // Cmd+Right: end of line (Ctrl-E)
      seq = "\x05";
    }

    if (seq) {
      const proc = getProcess();
      if (proc?.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(seq);
      }
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  document.addEventListener("keydown", handler, true);

  return () => {
    document.removeEventListener("keydown", handler, true);
  };
}
