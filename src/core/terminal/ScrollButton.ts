/**
 * Scroll-to-bottom overlay button for xterm.js terminals.
 *
 * Shows a down-arrow button when the terminal viewport is scrolled up,
 * hides when at the bottom. Clicking scrolls to bottom and focuses.
 */
import type { Terminal } from "@xterm/xterm";

export function attachScrollButton(
  containerEl: HTMLElement,
  terminal: Terminal,
  onScrollToBottom?: () => void,
): () => void {
  // Remove any existing button (e.g. from a previous reload)
  containerEl.querySelector(".wt-scroll-bottom")?.remove();

  const scrollBtn = document.createElement("button");
  scrollBtn.className = "wt-scroll-bottom";
  scrollBtn.setAttribute("aria-label", "Scroll to bottom");
  scrollBtn.innerHTML = "&#x2193;";
  scrollBtn.style.display = "none";
  containerEl.appendChild(scrollBtn);

  let visibilityRaf: number | null = null;
  let lastVisible = false;

  const updateVisibility = () => {
    visibilityRaf = null;
    const buf = terminal.buffer.active;
    const shouldShow = buf.viewportY < buf.baseY;
    if (shouldShow === lastVisible) return;
    lastVisible = shouldShow;
    scrollBtn.style.display = shouldShow ? "flex" : "none";
  };

  const scheduleVisibilityUpdate = () => {
    if (visibilityRaf !== null) return;
    visibilityRaf = requestAnimationFrame(updateVisibility);
  };

  const scrollDisposable = terminal.onScroll(scheduleVisibilityUpdate);

  // Also listen for native scroll on the viewport element, since xterm's
  // onScroll only fires for programmatic scrolls, not user trackpad/wheel.
  const viewport = containerEl.querySelector(".xterm-viewport");
  if (viewport) {
    viewport.addEventListener("scroll", scheduleVisibilityUpdate, { passive: true });
  }

  scrollBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    terminal.scrollToBottom();
    onScrollToBottom?.();
    terminal.focus();
    scheduleVisibilityUpdate();
  });

  scheduleVisibilityUpdate();

  return () => {
    scrollDisposable.dispose();
    if (viewport) {
      viewport.removeEventListener("scroll", scheduleVisibilityUpdate);
    }
    if (visibilityRaf !== null) {
      cancelAnimationFrame(visibilityRaf);
      visibilityRaf = null;
    }
    scrollBtn.remove();
  };
}
