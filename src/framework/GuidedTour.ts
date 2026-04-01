import type { Plugin } from "obsidian";
import { mergeAndSavePluginData } from "../core/PluginDataStore";

export const GUIDED_TOUR_VERSION = 1;

type GuidedTourStatus = "completed" | "dismissed";
type GuidedTourSurface = "board" | "settings";

interface GuidedTourRecord {
  version: number;
  status: GuidedTourStatus;
  updatedAt: string;
}

interface GuidedTourEligibilityRecord {
  eligible: boolean;
  updatedAt: string;
}

interface GuidedTourStep {
  title: string;
  body: string;
  target: string;
  placement?: "top" | "bottom" | "left" | "right";
  surface?: GuidedTourSurface;
  allowTargetFocus?: boolean;
  beforeShow?: () => void | Promise<void>;
}

interface GuidedTourDataShape {
  guidedTour?: GuidedTourRecord;
  guidedTourEligibility?: GuidedTourEligibilityRecord;
}

interface GuidedTourAutoStartContext {
  hasExistingItems?: boolean;
}

interface GuidedTourRuntimeState {
  activeController: object | null;
}

declare global {
  interface Window {
    __workTerminalGuidedTourState?: GuidedTourRuntimeState;
  }
}

function getGuidedTourRuntimeState(): GuidedTourRuntimeState {
  if (!window.__workTerminalGuidedTourState) {
    window.__workTerminalGuidedTourState = {
      activeController: null,
    };
  }
  return window.__workTerminalGuidedTourState;
}

function isGuidedTourRunning(): boolean {
  return getGuidedTourRuntimeState().activeController !== null;
}

function claimGuidedTourSingleton(controller: object): boolean {
  const runtimeState = getGuidedTourRuntimeState();
  if (runtimeState.activeController && runtimeState.activeController !== controller) {
    return false;
  }
  runtimeState.activeController = controller;
  return true;
}

function releaseGuidedTourSingleton(controller: object): void {
  const runtimeState = getGuidedTourRuntimeState();
  if (runtimeState.activeController === controller) {
    runtimeState.activeController = null;
  }
}

export function resetGuidedTourSingletonForTests(): void {
  delete window.__workTerminalGuidedTourState;
}

function createChild<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tagName);
  el.className = className;
  if (text) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const interactiveAncestor = target.closest(
    'input, textarea, select, button, [contenteditable=""], [contenteditable="true"], [role="button"], [role="checkbox"], [role="combobox"], [role="gridcell"], [role="link"], [role="listbox"], [role="menuitem"], [role="option"], [role="radio"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="switch"], [role="tab"], [role="textbox"]',
  );
  return interactiveAncestor !== null;
}

function isTabbableElement(element: HTMLElement): boolean {
  if (element.matches(":disabled")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;

  const tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && Number(tabIndex) < 0) return false;

  const supportsCheckVisibility = typeof element.checkVisibility === "function";
  if (
    supportsCheckVisibility &&
    !element.checkVisibility({
      checkOpacity: false,
      checkVisibilityCSS: true,
    })
  ) {
    return false;
  }

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) return false;
    if (current.hasAttribute("inert")) return false;
    if (current.getAttribute("aria-hidden") === "true") return false;

    if (supportsCheckVisibility) continue;

    const style = window.getComputedStyle(current);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  }

  return true;
}

const TABBABLE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable=""], [contenteditable="true"], [tabindex]';

function getTabbableElements(container: HTMLElement): HTMLElement[] {
  const elements = Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    isTabbableElement,
  );
  if (container.matches(TABBABLE_SELECTOR) && isTabbableElement(container)) {
    elements.unshift(container);
  }
  return elements;
}

function readGuidedTourRecord(data: unknown): GuidedTourRecord | null {
  if (!isRecord(data) || !isRecord(data.guidedTour)) return null;
  const version = data.guidedTour.version;
  const status = data.guidedTour.status;
  const updatedAt = data.guidedTour.updatedAt;
  if (typeof version !== "number") return null;
  if (status !== "completed" && status !== "dismissed") return null;
  if (typeof updatedAt !== "string") return null;
  return { version, status, updatedAt };
}

function readGuidedTourEligibilityRecord(data: unknown): GuidedTourEligibilityRecord | null {
  if (!isRecord(data) || !isRecord(data.guidedTourEligibility)) return null;
  const eligible = data.guidedTourEligibility.eligible;
  const updatedAt = data.guidedTourEligibility.updatedAt;
  if (typeof eligible !== "boolean") return null;
  if (typeof updatedAt !== "string") return null;
  return { eligible, updatedAt };
}

function hasMeaningfulPluginData(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return Object.keys(data).some((key) => key !== "guidedTour" && key !== "guidedTourEligibility");
}

async function saveGuidedTourEligibility(plugin: Plugin, eligible: boolean): Promise<void> {
  await mergeAndSavePluginData(plugin, async (data: GuidedTourDataShape) => {
    data.guidedTourEligibility = {
      eligible,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function shouldAutoStartGuidedTour(
  plugin: Plugin,
  context: GuidedTourAutoStartContext = {},
): Promise<boolean> {
  if (isGuidedTourRunning()) {
    return false;
  }

  const rawData = await plugin.loadData();
  const record = readGuidedTourRecord(rawData);
  if (record) {
    return record.version !== GUIDED_TOUR_VERSION;
  }

  const eligibility = readGuidedTourEligibilityRecord(rawData);
  if (eligibility) {
    return eligibility.eligible;
  }

  const derivedEligibility = !context.hasExistingItems && !hasMeaningfulPluginData(rawData);
  await saveGuidedTourEligibility(plugin, derivedEligibility);
  return derivedEligibility;
}

export async function saveGuidedTourStatus(
  plugin: Plugin,
  status: GuidedTourStatus,
): Promise<void> {
  await mergeAndSavePluginData(plugin, async (data: GuidedTourDataShape) => {
    data.guidedTourEligibility = {
      eligible: true,
      updatedAt: new Date().toISOString(),
    };
    data.guidedTour = {
      version: GUIDED_TOUR_VERSION,
      status,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function resetGuidedTourStatus(plugin: Plugin): Promise<void> {
  await mergeAndSavePluginData(plugin, async (data: GuidedTourDataShape) => {
    delete data.guidedTour;
    data.guidedTourEligibility = {
      eligible: true,
      updatedAt: new Date().toISOString(),
    };
  });
}

export class GuidedTourController {
  private static readonly BOARD_FOCUS_RESTORE_SELECTORS = [
    '[data-wt-tour="prompt-box"] .wt-prompt-toggle',
    ".wt-filter-input",
    '[data-wt-tour="launch-buttons"] button',
    '[data-wt-tour="custom-session-button"]',
  ];

  private readonly steps: GuidedTourStep[];
  private layerEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private highlightEl: HTMLElement | null = null;
  private cardEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private counterEl: HTMLElement | null = null;
  private backButtonEl: HTMLButtonElement | null = null;
  private nextButtonEl: HTMLButtonElement | null = null;
  private skipButtonEl: HTMLButtonElement | null = null;
  private activeTargetEl: HTMLElement | null = null;
  private chromeHostEl: HTMLElement | null = null;
  private chromeHostOriginalPosition: string | null = null;
  private openedSettingsForTour = false;
  private activeIndex = 0;
  private positionFrameId: number | null = null;
  private positionInFlight = false;
  private pendingPosition = false;
  private pendingScrollIntoView = false;
  private latestPositionRequestId = 0;
  private isTransitioning = false;
  private isDisposed = false;
  private isFinishing = false;
  private restoreFocusTarget: HTMLElement | null = null;
  private readonly handleResize = () => this.schedulePosition();
  private readonly handleScroll = () => this.schedulePosition();
  private readonly handleFocusIn = (event: FocusEvent) => {
    if (!this.cardEl || this.isDisposed || this.isFinishing) return;
    this.maybeStoreRestoreFocusTarget(event.target);
    if (this.isAllowedFocusTarget(event.target)) return;
    this.focusWithinCard();
  };
  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (this.isDisposed || this.isFinishing) return;

    if (event.key === "Escape") {
      event.preventDefault();
      void this.finish("dismissed");
      return;
    }

    if (event.key === "Tab") {
      this.cycleCardFocus(event);
      return;
    }

    if (isInteractiveShortcutTarget(event.target)) {
      return;
    }

    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      void this.goNext();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      void this.goBack();
    }
  };

  constructor(
    private readonly plugin: Plugin,
    steps: GuidedTourStep[] = createDefaultGuidedTourSteps(plugin),
  ) {
    this.steps = steps;
  }

  async start(): Promise<void> {
    if (!this.steps.length || this.cardEl) return;
    if (!claimGuidedTourSingleton(this)) return;

    this.isDisposed = false;
    this.restoreFocusTarget = this.resolveRestorableFocusTarget(document.activeElement);
    try {
      this.createChrome();
      this.registerEvents();
      await this.showStep(0);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    this.isDisposed = true;
    this.latestPositionRequestId += 1;
    this.unregisterEvents();
    if (this.positionFrameId !== null) {
      window.cancelAnimationFrame(this.positionFrameId);
      this.positionFrameId = null;
    }
    this.pendingPosition = false;
    this.pendingScrollIntoView = false;
    this.isTransitioning = false;
    this.clearActiveTarget();
    this.restoreChromeHost();
    this.layerEl?.remove();
    this.backdropEl?.remove();
    this.highlightEl?.remove();
    this.cardEl?.remove();
    this.layerEl = null;
    this.backdropEl = null;
    this.highlightEl = null;
    this.cardEl = null;
    this.titleEl = null;
    this.bodyEl = null;
    this.counterEl = null;
    this.backButtonEl = null;
    this.nextButtonEl = null;
    this.skipButtonEl = null;
    releaseGuidedTourSingleton(this);
  }

  private createChrome(): void {
    this.layerEl = createChild(document.body, "div", "wt-tour-layer");
    this.chromeHostEl = document.body;
    this.backdropEl = createChild(this.layerEl, "div", "wt-tour-backdrop");
    this.highlightEl = createChild(this.layerEl, "div", "wt-tour-highlight");
    this.cardEl = createChild(this.layerEl, "div", "wt-tour-card");
    this.cardEl.setAttribute("role", "dialog");
    this.cardEl.tabIndex = -1;

    this.counterEl = createChild(this.cardEl, "div", "wt-tour-counter");
    this.titleEl = createChild(this.cardEl, "h3", "wt-tour-title");
    this.titleEl.id = "wt-tour-title";
    this.cardEl.setAttribute("aria-labelledby", this.titleEl.id);
    this.bodyEl = createChild(this.cardEl, "p", "wt-tour-body");

    const actionsEl = createChild(this.cardEl, "div", "wt-tour-actions");
    this.skipButtonEl = createChild(actionsEl, "button", "wt-tour-btn", "Skip");
    this.skipButtonEl.addEventListener("click", () => {
      void this.finish("dismissed");
    });

    const navEl = createChild(actionsEl, "div", "wt-tour-nav");
    this.backButtonEl = createChild(navEl, "button", "wt-tour-btn", "Back");
    this.backButtonEl.addEventListener("click", () => {
      void this.goBack();
    });
    this.nextButtonEl = createChild(navEl, "button", "wt-tour-btn wt-tour-btn-primary", "Next");
    this.nextButtonEl.addEventListener("click", () => {
      void this.goNext();
    });
  }

  private registerEvents(): void {
    window.addEventListener("resize", this.handleResize);
    document.addEventListener("scroll", this.handleScroll, true);
    document.addEventListener("focusin", this.handleFocusIn, true);
    document.addEventListener("keydown", this.handleKeydown, true);
  }

  private unregisterEvents(): void {
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("scroll", this.handleScroll, true);
    document.removeEventListener("focusin", this.handleFocusIn, true);
    document.removeEventListener("keydown", this.handleKeydown, true);
  }

  private async goBack(): Promise<void> {
    if (this.activeIndex <= 0) return;
    await this.runTransition(async () => {
      await this.showStep(this.activeIndex - 1);
    });
  }

  private async goNext(): Promise<void> {
    await this.runTransition(async () => {
      if (this.activeIndex >= this.steps.length - 1) {
        await this.finish("completed");
        return;
      }
      await this.showStep(this.activeIndex + 1);
    });
  }

  private async finish(status: GuidedTourStatus): Promise<void> {
    if (this.isDisposed || this.isFinishing) return;

    this.isFinishing = true;
    try {
      await this.restoreSurfaceBeforeFinish();
      await saveGuidedTourStatus(this.plugin, status);
    } finally {
      this.dispose();
    }

    await this.waitForNextFrame();
    this.restoreFocusAfterFinish();
  }

  private async showStep(index: number): Promise<void> {
    const step = this.steps[index];
    if (!step || !this.cardEl || !this.titleEl || !this.bodyEl || !this.counterEl) return;
    this.activeIndex = index;
    await this.syncSurface(step.surface ?? "board");
    if (this.isDisposed || !this.cardEl || !this.titleEl || !this.bodyEl || !this.counterEl) return;
    await step.beforeShow?.();
    if (this.isDisposed || !this.cardEl || !this.titleEl || !this.bodyEl || !this.counterEl) return;
    this.titleEl.textContent = step.title;
    this.bodyEl.textContent = step.body;
    this.counterEl.textContent = `Step ${index + 1} of ${this.steps.length}`;
    if (this.backButtonEl) {
      this.backButtonEl.disabled = index === 0 || this.isTransitioning;
    }
    if (this.nextButtonEl) {
      this.nextButtonEl.textContent = index === this.steps.length - 1 ? "Finish" : "Next";
      this.nextButtonEl.disabled = this.isTransitioning;
    }
    if (this.skipButtonEl) {
      this.skipButtonEl.disabled = this.isTransitioning;
    }
    await this.runPositionCurrentStep({ scrollIntoView: true });
    this.cardEl?.focus();
  }

  private async syncSurface(surface: GuidedTourSurface): Promise<void> {
    if (this.isDisposed) return;
    const settings = (this.plugin.app as any).setting;
    if (surface === "settings") {
      const wasOpen = this.isPluginSettingsOpen();
      settings?.open?.();
      settings?.openTabById?.(this.plugin.manifest.id);
      this.openedSettingsForTour ||= !wasOpen;
    } else {
      settings?.close?.();
    }
    await this.waitForNextFrame();
  }

  private async restoreSurfaceBeforeFinish(): Promise<void> {
    if ((this.steps[this.activeIndex]?.surface ?? "board") !== "settings") return;
    if (!this.openedSettingsForTour) return;

    this.unregisterEvents();
    const settings = (this.plugin.app as any).setting;
    settings?.close?.();
    await this.waitForNextFrame();
  }

  private schedulePosition(options: { scrollIntoView?: boolean } = {}): void {
    this.pendingPosition = true;
    this.pendingScrollIntoView ||= options.scrollIntoView === true;
    if (this.positionFrameId !== null) return;
    this.positionFrameId = window.requestAnimationFrame(() => {
      this.positionFrameId = null;
      void this.runPositionCurrentStep();
    });
  }

  private async runPositionCurrentStep(options: { scrollIntoView?: boolean } = {}): Promise<void> {
    this.pendingPosition = true;
    this.pendingScrollIntoView ||= options.scrollIntoView === true;
    if (this.positionInFlight) return;

    while (this.pendingPosition || this.pendingScrollIntoView) {
      const shouldScrollIntoView = this.pendingScrollIntoView;
      this.pendingPosition = false;
      this.pendingScrollIntoView = false;
      this.positionInFlight = true;
      const requestId = ++this.latestPositionRequestId;
      try {
        await this.positionCurrentStep(requestId, shouldScrollIntoView);
      } finally {
        this.positionInFlight = false;
      }
    }
  }

  private async positionCurrentStep(requestId: number, scrollIntoView: boolean): Promise<void> {
    const step = this.steps[this.activeIndex];
    if (!step || !this.cardEl || !this.highlightEl) return;

    const chromeHost = this.resolveChromeHost(step.surface ?? "board");
    this.attachChromeToHost(chromeHost);

    const target = await this.waitForTarget(step.target);
    if (this.isDisposed || requestId !== this.latestPositionRequestId) return;
    if (!this.cardEl || !this.highlightEl || !this.backdropEl) return;

    this.clearActiveTarget();
    if (!target) {
      const hostRect = this.getChromeHostRect();
      this.backdropEl.style.clipPath = "";
      this.backdropEl.style.display = "";
      this.highlightEl.style.display = "none";
      this.cardEl.style.top = `${hostRect.height / 2}px`;
      this.cardEl.style.left = `${hostRect.width / 2}px`;
      this.cardEl.style.transform = "translate(-50%, -50%)";
      return;
    }

    this.activeTargetEl = target;
    this.activeTargetEl.classList.add("wt-tour-target");
    if (scrollIntoView) {
      this.activeTargetEl.scrollIntoView({ block: "center", inline: "nearest" });
      await this.waitForNextFrame();
      if (this.isDisposed || requestId !== this.latestPositionRequestId) return;
      if (!this.cardEl || !this.highlightEl) return;
    }

    const hostRect = this.getChromeHostRect();
    const targetRect = target.getBoundingClientRect();
    const rect = new DOMRect(
      targetRect.left - hostRect.left,
      targetRect.top - hostRect.top,
      targetRect.width,
      targetRect.height,
    );
    this.backdropEl.style.display = "";
    this.backdropEl.style.clipPath = this.createBackdropClipPath(rect, hostRect);
    this.highlightEl.style.display = "";
    this.highlightEl.style.top = `${rect.top - 8}px`;
    this.highlightEl.style.left = `${rect.left - 8}px`;
    this.highlightEl.style.width = `${rect.width + 16}px`;
    this.highlightEl.style.height = `${rect.height + 16}px`;

    const cardWidth = this.cardEl.offsetWidth || 320;
    const cardHeight = this.cardEl.offsetHeight || 220;
    const { top, left } = this.computeCardPosition(rect, cardWidth, cardHeight, step.placement);
    this.cardEl.style.top = `${top}px`;
    this.cardEl.style.left = `${left}px`;
    this.cardEl.style.transform = "none";
  }

  private computeCardPosition(
    rect: DOMRect,
    cardWidth: number,
    cardHeight: number,
    placement: GuidedTourStep["placement"] = "bottom",
    hostRect = this.getChromeHostRect(),
  ): { top: number; left: number } {
    const gap = 16;
    const margin = 16;
    const viewportWidth = hostRect.width;
    const viewportHeight = hostRect.height;

    let top = rect.bottom + gap;
    let left = rect.left;

    if (placement === "top") {
      top = rect.top - cardHeight - gap;
    } else if (placement === "left") {
      top = rect.top;
      left = rect.left - cardWidth - gap;
    } else if (placement === "right") {
      top = rect.top;
      left = rect.right + gap;
    }

    if (placement === "bottom" || placement === "top") {
      left = rect.left + rect.width / 2 - cardWidth / 2;
    }

    top = Math.min(Math.max(margin, top), viewportHeight - cardHeight - margin);
    left = Math.min(Math.max(margin, left), viewportWidth - cardWidth - margin);
    return { top, left };
  }

  private async runTransition(work: () => Promise<void>): Promise<void> {
    if (this.isDisposed || this.isTransitioning) return;

    this.isTransitioning = true;
    this.updateNavigationState();
    try {
      await work();
    } finally {
      this.isTransitioning = false;
      this.updateNavigationState();
    }
  }

  private updateNavigationState(): void {
    if (this.backButtonEl) {
      this.backButtonEl.disabled = this.activeIndex === 0 || this.isTransitioning;
    }
    if (this.nextButtonEl) {
      this.nextButtonEl.disabled = this.isTransitioning;
    }
    if (this.skipButtonEl) {
      this.skipButtonEl.disabled = this.isTransitioning;
    }
  }

  private resolveChromeHost(surface: GuidedTourSurface): HTMLElement {
    if (surface !== "settings") {
      return document.body;
    }

    const modal = Array.from(document.querySelectorAll<HTMLElement>(".modal")).at(-1);
    if (modal) return modal;

    const modalContainer = Array.from(
      document.querySelectorAll<HTMLElement>(".modal-container"),
    ).at(-1);
    return modalContainer ?? document.body;
  }

  private attachChromeToHost(host: HTMLElement): void {
    if (!this.layerEl || this.chromeHostEl === host) return;

    this.restoreChromeHost();
    if (host !== document.body && window.getComputedStyle(host).position === "static") {
      this.chromeHostOriginalPosition = host.style.position;
      host.style.position = "relative";
    }

    this.chromeHostEl = host;
    this.layerEl.classList.toggle("wt-tour-layer-local", host !== document.body);
    host.appendChild(this.layerEl);
  }

  private restoreChromeHost(): void {
    if (!this.chromeHostEl || this.chromeHostEl === document.body) {
      this.chromeHostEl = null;
      this.chromeHostOriginalPosition = null;
      return;
    }

    this.chromeHostEl.style.position = this.chromeHostOriginalPosition ?? "";
    this.chromeHostEl = null;
    this.chromeHostOriginalPosition = null;
  }

  private getChromeHostRect(): DOMRect {
    if (!this.chromeHostEl || this.chromeHostEl === document.body) {
      return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    }

    return this.chromeHostEl.getBoundingClientRect();
  }

  private createBackdropClipPath(rect: DOMRect, hostRect: DOMRect): string {
    const left = Math.max(0, rect.left - 8);
    const top = Math.max(0, rect.top - 8);
    const right = Math.min(hostRect.width, rect.right + 8);
    const bottom = Math.min(hostRect.height, rect.bottom + 8);

    return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`;
  }

  private cycleCardFocus(event: KeyboardEvent): void {
    if (!this.cardEl) return;

    const tabbableElements = this.getAllowedTabbableElements();
    if (!tabbableElements.length) {
      event.preventDefault();
      this.cardEl.focus();
      return;
    }

    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeIndex = activeElement ? tabbableElements.indexOf(activeElement) : -1;
    const nextIndex =
      activeIndex === -1
        ? event.shiftKey
          ? tabbableElements.length - 1
          : 0
        : (activeIndex + (event.shiftKey ? -1 : 1) + tabbableElements.length) %
          tabbableElements.length;

    event.preventDefault();
    tabbableElements[nextIndex]?.focus();
  }

  private focusWithinCard(): void {
    if (!this.cardEl) return;
    const [firstTabbable] = this.getAllowedTabbableElements();
    (firstTabbable ?? this.cardEl).focus();
  }

  private getAllowedTabbableElements(): HTMLElement[] {
    const allowedElements =
      this.activeTargetEl && this.steps[this.activeIndex]?.allowTargetFocus
        ? getTabbableElements(this.activeTargetEl)
        : [];
    const seen = new Set<HTMLElement>(allowedElements);
    for (const element of getTabbableElements(this.cardEl!)) {
      if (seen.has(element)) continue;
      seen.add(element);
      allowedElements.push(element);
    }
    return allowedElements;
  }

  private isAllowedFocusTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Node) || !this.cardEl) return false;
    if (this.cardEl.contains(target)) return true;
    if (!this.steps[this.activeIndex]?.allowTargetFocus) return false;
    return this.activeTargetEl?.contains(target) ?? false;
  }

  private clearActiveTarget(): void {
    this.activeTargetEl?.classList.remove("wt-tour-target");
    this.activeTargetEl = null;
  }

  private isPluginSettingsOpen(): boolean {
    return (
      document.querySelector(
        ".modal .settings-root, .modal .vertical-tab-content-container, .modal .vertical-tab-nav",
      ) !== null
    );
  }

  private focusStableBoardControl(): void {
    for (const selector of GuidedTourController.BOARD_FOCUS_RESTORE_SELECTORS) {
      const target = document.querySelector<HTMLElement>(selector);
      if (!target || !isTabbableElement(target)) continue;
      target.focus();
      if (document.activeElement === target) {
        return;
      }
    }
  }

  private maybeStoreRestoreFocusTarget(target: EventTarget | null): void {
    const restorableTarget = this.resolveRestorableFocusTarget(target);
    if (!restorableTarget) return;
    if (!this.activeTargetEl?.contains(restorableTarget)) return;
    this.restoreFocusTarget = restorableTarget;
  }

  private resolveRestorableFocusTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    if (target === document.body || target === document.documentElement) return null;
    if (!target.isConnected) return null;
    if (target.closest(".wt-tour-layer")) return null;
    if (!isTabbableElement(target)) return null;
    return target;
  }

  private restoreFocusAfterFinish(): void {
    const restorableTarget = this.resolveRestorableFocusTarget(this.restoreFocusTarget);
    if (restorableTarget) {
      restorableTarget.focus();
      if (document.activeElement === restorableTarget) {
        return;
      }
    }
    this.focusStableBoardControl();
  }

  private async waitForNextFrame(): Promise<void> {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  private async waitForTarget(selector: string): Promise<HTMLElement | null> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) return target;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return null;
  }
}

export function createDefaultGuidedTourSteps(_plugin: Plugin): GuidedTourStep[] {
  return [
    {
      title: "Welcome to Work Terminal",
      body: "This view keeps your work list on the left and task-specific terminals on the right, so you can move from planning to execution in one place.",
      target: ".wt-main-view",
      placement: "bottom",
      surface: "board",
    },
    {
      title: "Add a new task from here",
      body: "Use the prompt box to create a new task without leaving the board. Pick the destination column, then press Enter or Create.",
      target: '[data-wt-tour="prompt-box"]',
      placement: "right",
      surface: "board",
      allowTargetFocus: true,
    },
    {
      title: "Select work from the board",
      body: "Your tasks appear here. Click a task card once you have one to focus it, then keep an eye on the board for shell and agent activity badges.",
      target: '[data-wt-tour="list-panel"]',
      placement: "right",
      surface: "board",
    },
    {
      title: "Launch Shell and Claude sessions",
      body: "Once a task is selected, use these buttons to open a shell, start Claude, or launch Claude with saved extra context.",
      target: '[data-wt-tour="launch-buttons"]',
      placement: "left",
      surface: "board",
      allowTargetFocus: true,
    },
    {
      title: "Rename and rearrange tabs",
      body: "Once you launch your first session, tabs appear here. Double-click a tab label to rename it, drag tabs to reorder them, and close tabs with the x button.",
      target: '[data-wt-tour="tab-bar"]',
      placement: "left",
      surface: "board",
    },
    {
      title: "Find the profile launcher",
      body: "This menu opens the profile launcher. Select a task first, then pick a profile with optional overrides for working directory, label, and extra CLI arguments. You can also restore recently closed sessions.",
      target: '[data-wt-tour="custom-session-button"]',
      placement: "left",
      surface: "board",
      allowTargetFocus: true,
    },
    {
      title: "Set default Claude arguments",
      body: "These settings apply every time Claude launches. Use them for shared flags, model selection, or any standard CLI arguments you want on by default.",
      target: '[data-wt-tour="core.claudeExtraArgs"]',
      placement: "right",
      surface: "settings",
      allowTargetFocus: true,
    },
    {
      title: "Save reusable task context",
      body: "This template feeds extra context into Claude (ctx) and contextual custom sessions. It is the best place for instructions like reading the task file first.",
      target: '[data-wt-tour="core.additionalAgentContext"]',
      placement: "right",
      surface: "settings",
      allowTargetFocus: true,
    },
  ];
}
