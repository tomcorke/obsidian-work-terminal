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
  beforeShow?: () => void | Promise<void>;
}

interface GuidedTourDataShape {
  guidedTour?: GuidedTourRecord;
  guidedTourEligibility?: GuidedTourEligibilityRecord;
}

interface GuidedTourAutoStartContext {
  hasExistingItems?: boolean;
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

export class GuidedTourController {
  private readonly steps: GuidedTourStep[];
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
  private activeIndex = 0;
  private positionFrameId: number | null = null;
  private positionInFlight = false;
  private pendingPosition = false;
  private pendingScrollIntoView = false;
  private latestPositionRequestId = 0;
  private isDisposed = false;
  private readonly handleResize = () => this.schedulePosition();
  private readonly handleScroll = () => this.schedulePosition();
  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void this.finish("dismissed");
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
    this.isDisposed = false;
    this.createChrome();
    this.registerEvents();
    await this.showStep(0);
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
    this.clearActiveTarget();
    this.backdropEl?.remove();
    this.highlightEl?.remove();
    this.cardEl?.remove();
    this.backdropEl = null;
    this.highlightEl = null;
    this.cardEl = null;
    this.titleEl = null;
    this.bodyEl = null;
    this.counterEl = null;
    this.backButtonEl = null;
    this.nextButtonEl = null;
    this.skipButtonEl = null;
  }

  private createChrome(): void {
    this.backdropEl = createChild(document.body, "div", "wt-tour-backdrop");
    this.highlightEl = createChild(document.body, "div", "wt-tour-highlight");
    this.cardEl = createChild(document.body, "div", "wt-tour-card");
    this.cardEl.setAttribute("role", "dialog");
    this.cardEl.setAttribute("aria-modal", "true");
    this.cardEl.tabIndex = -1;

    this.counterEl = createChild(this.cardEl, "div", "wt-tour-counter");
    this.titleEl = createChild(this.cardEl, "h3", "wt-tour-title");
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
    document.addEventListener("keydown", this.handleKeydown, true);
  }

  private unregisterEvents(): void {
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("scroll", this.handleScroll, true);
    document.removeEventListener("keydown", this.handleKeydown, true);
  }

  private async goBack(): Promise<void> {
    if (this.activeIndex <= 0) return;
    await this.showStep(this.activeIndex - 1);
  }

  private async goNext(): Promise<void> {
    if (this.activeIndex >= this.steps.length - 1) {
      await this.finish("completed");
      return;
    }
    await this.showStep(this.activeIndex + 1);
  }

  private async finish(status: GuidedTourStatus): Promise<void> {
    await saveGuidedTourStatus(this.plugin, status);
    this.dispose();
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
      this.backButtonEl.disabled = index === 0;
    }
    if (this.nextButtonEl) {
      this.nextButtonEl.textContent = index === this.steps.length - 1 ? "Finish" : "Next";
    }
    await this.runPositionCurrentStep({ scrollIntoView: true });
    this.cardEl.focus();
  }

  private async syncSurface(surface: GuidedTourSurface): Promise<void> {
    if (this.isDisposed) return;
    const settings = (this.plugin.app as any).setting;
    if (surface === "settings") {
      settings?.open?.();
      settings?.openTabById?.(this.plugin.manifest.id);
    } else {
      settings?.close?.();
    }
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

    const target = await this.waitForTarget(step.target);
    if (this.isDisposed || requestId !== this.latestPositionRequestId) return;
    if (!this.cardEl || !this.highlightEl) return;

    this.clearActiveTarget();
    if (!target) {
      this.highlightEl.style.display = "none";
      this.cardEl.style.top = "50%";
      this.cardEl.style.left = "50%";
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

    const rect = target.getBoundingClientRect();
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
  ): { top: number; left: number } {
    const gap = 16;
    const margin = 16;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

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

  private clearActiveTarget(): void {
    this.activeTargetEl?.classList.remove("wt-tour-target");
    this.activeTargetEl = null;
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

export function createDefaultGuidedTourSteps(plugin: Plugin): GuidedTourStep[] {
  return [
    {
      title: "Welcome to Work Terminal",
      body:
        "This view keeps your work list on the left and task-specific terminals on the right, so you can move from planning to execution in one place.",
      target: ".wt-main-view",
      placement: "bottom",
      surface: "board",
    },
    {
      title: "Add a new task from here",
      body:
        "Use the prompt box to create a new task without leaving the board. Pick the destination column, then press Enter or Create.",
      target: '[data-wt-tour="prompt-box"]',
      placement: "right",
      surface: "board",
    },
    {
      title: "Select work from the board",
      body:
        "Your tasks appear here. Click a task card once you have one to focus it, then keep an eye on the board for shell and agent activity badges.",
      target: '[data-wt-tour="list-panel"]',
      placement: "right",
      surface: "board",
    },
    {
      title: "Launch Shell and Claude sessions",
      body:
        "Once a task is selected, use these buttons to open a shell, start Claude, or launch Claude with saved extra context.",
      target: '[data-wt-tour="launch-buttons"]',
      placement: "left",
      surface: "board",
    },
    {
      title: "Rename and rearrange tabs",
      body:
        "Once you launch your first session, tabs appear here. Double-click a tab label to rename it, drag tabs to reorder them, and close tabs with the x button.",
      target: '[data-wt-tour="tab-bar"]',
      placement: "left",
      surface: "board",
    },
    {
      title: "Find the custom session launcher",
      body:
        "This menu opens the custom session dialog. Select a task first, then use it for Copilot, Strands, extra CLI arguments, or recent-session restore.",
      target: '[data-wt-tour="custom-session-button"]',
      placement: "left",
      surface: "board",
    },
    {
      title: "Set default Claude arguments",
      body:
        "These settings apply every time Claude launches. Use them for shared flags, model selection, or any standard CLI arguments you want on by default.",
      target: '[data-wt-tour="core.claudeExtraArgs"]',
      placement: "right",
      surface: "settings",
    },
    {
      title: "Save reusable task context",
      body:
        "This template feeds extra context into Claude (ctx) and contextual custom sessions. It is the best place for instructions like reading the task file first.",
      target: '[data-wt-tour="core.additionalAgentContext"]',
      placement: "right",
      surface: "settings",
    },
  ];
}
