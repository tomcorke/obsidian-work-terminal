// @vitest-environment jsdom
/**
 * Issue #473: SettingsTab render order must be deterministic.
 *
 * These tests pin the render-order invariant documented at the top of
 * `SettingsTab.ts`: settings render in the exact order their
 * `new Setting(containerEl)` calls are issued from `display()`, regardless
 * of how `loadData()` promises resolve.
 *
 * We exercise:
 *   - declared-order for a realistic adapter with columns, card flags,
 *     enrichment fields, and agent-action fields (every section rendered);
 *   - interleaving of Detail view + Agents (the specific bug reported in
 *     #473) under deliberately delayed `loadData()` resolution;
 *   - stability across repeated `display()` calls (simulating a user
 *     flipping a toggle and triggering a re-render);
 *   - no post-return re-entry (the DOM must not grow after `display()`
 *     has finished resolving its initial load);
 *   - a stress test against `loadData()` queued behind many pending
 *     microtasks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkHookStatusMock, resetGuidedTourStatusMock, NoticeMock } = vi.hoisted(() => ({
  checkHookStatusMock: vi.fn(() => ({
    scriptExists: false,
    hooksConfigured: false,
  })),
  resetGuidedTourStatusMock: vi.fn(async () => {}),
  NoticeMock: vi.fn(),
}));

vi.mock("obsidian", () => {
  class App {}

  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: HTMLElement;

    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement("div");
    }
  }

  class Setting {
    settingEl: HTMLDivElement;
    nameEl: HTMLDivElement;
    descEl: HTMLDivElement;
    controlEl: HTMLDivElement;

    constructor(containerEl: HTMLElement) {
      this.settingEl = document.createElement("div");
      this.settingEl.classList.add("setting-item");
      this.nameEl = document.createElement("div");
      this.nameEl.classList.add("setting-item-name");
      this.descEl = document.createElement("div");
      this.controlEl = document.createElement("div");
      this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
      containerEl.appendChild(this.settingEl);
    }

    setName(name: string) {
      this.nameEl.textContent = name;
      return this;
    }
    setDesc(description: string) {
      this.descEl.textContent = description;
      return this;
    }
    addText(
      callback: (text: {
        inputEl: HTMLInputElement;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("input");
      this.controlEl.appendChild(inputEl);
      const text = {
        inputEl,
        setValue(value: string) {
          inputEl.value = value;
          return text;
        },
        onChange(handler: (value: string) => void) {
          inputEl.addEventListener("input", () => handler(inputEl.value));
          return text;
        },
      };
      callback(text);
      return this;
    }
    addTextArea(
      callback: (text: {
        inputEl: HTMLTextAreaElement;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("textarea");
      this.controlEl.appendChild(inputEl);
      const text = {
        inputEl,
        setValue(value: string) {
          inputEl.value = value;
          return text;
        },
        onChange(handler: (value: string) => void) {
          inputEl.addEventListener("input", () => handler(inputEl.value));
          return text;
        },
      };
      callback(text);
      return this;
    }
    addToggle(
      callback: (toggle: {
        setValue: (value: boolean) => any;
        onChange: (handler: (value: boolean) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("input");
      inputEl.type = "checkbox";
      this.controlEl.appendChild(inputEl);
      const toggle = {
        setValue(value: boolean) {
          inputEl.checked = value;
          return toggle;
        },
        onChange(handler: (value: boolean) => void) {
          inputEl.addEventListener("change", () => handler(inputEl.checked));
          return toggle;
        },
      };
      callback(toggle);
      return this;
    }
    addButton(
      callback: (button: {
        setButtonText: (value: string) => any;
        setCta: () => any;
        setWarning: () => any;
        onClick: (handler: () => void | Promise<void>) => any;
      }) => void,
    ) {
      const buttonEl = document.createElement("button");
      this.controlEl.appendChild(buttonEl);
      const button = {
        setButtonText(value: string) {
          buttonEl.textContent = value;
          return button;
        },
        setCta() {
          return button;
        },
        setWarning() {
          return button;
        },
        onClick(handler: () => void | Promise<void>) {
          buttonEl.addEventListener("click", () => void handler());
          return button;
        },
      };
      callback(button);
      return this;
    }
    addDropdown(
      callback: (dropdown: {
        addOption: (value: string, label: string) => any;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const selectEl = document.createElement("select");
      this.controlEl.appendChild(selectEl);
      const dropdown = {
        addOption(value: string, label: string) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          selectEl.appendChild(option);
          return dropdown;
        },
        setValue(value: string) {
          selectEl.value = value;
          return dropdown;
        },
        onChange(handler: (value: string) => void) {
          selectEl.addEventListener("change", () => handler(selectEl.value));
          return dropdown;
        },
      };
      callback(dropdown);
      return this;
    }
  }

  class Modal {
    app: unknown;
    contentEl: HTMLElement;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
    }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
  }

  return { App, Modal, Notice: NoticeMock, PluginSettingTab, Setting };
});

vi.mock("./GuidedTour", () => ({
  resetGuidedTourStatus: resetGuidedTourStatusMock,
}));

vi.mock("../core/claude/ClaudeHookManager", () => ({
  checkHookStatus: checkHookStatusMock,
  installHooks: vi.fn(),
  removeHooks: vi.fn(),
}));

vi.mock("../core/PluginDataStore", () => ({
  mergeAndSavePluginData: async (
    plugin: {
      loadData: () => Promise<Record<string, any> | null>;
      saveData: (data: Record<string, any>) => Promise<void>;
    },
    update: (data: Record<string, any>) => void | Promise<void>,
  ) => {
    const data = (await plugin.loadData()) || {};
    await update(data);
    await plugin.saveData(data);
  },
}));

import { WorkTerminalSettingsTab } from "./SettingsTab";

type CreateChildOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
};
type ObsidianHTMLElement = HTMLElement & {
  createEl: (tag: string, options?: CreateChildOptions) => HTMLElement;
  createDiv: (options?: CreateChildOptions) => HTMLDivElement;
  createSpan: (options?: CreateChildOptions) => HTMLSpanElement;
  addClass: (...classes: string[]) => void;
  empty: () => void;
};
type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  createEl: ObsidianHTMLElement["createEl"];
  createDiv: ObsidianHTMLElement["createDiv"];
  createSpan: ObsidianHTMLElement["createSpan"];
  addClass: ObsidianHTMLElement["addClass"];
  empty: ObsidianHTMLElement["empty"];
};

function installDomHelpers() {
  const prototype = HTMLElement.prototype as ObsidianHTMLElementPrototype;
  const createEl = function (
    this: ObsidianHTMLElement,
    tag: string,
    options: CreateChildOptions = {},
  ) {
    const el = document.createElement(tag) as ObsidianHTMLElement;
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    if (options.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        el.setAttribute(key, value);
      }
    }
    this.appendChild(el);
    return el;
  };
  prototype.createEl = createEl;
  prototype.createDiv = function (this: ObsidianHTMLElement, options: CreateChildOptions = {}) {
    return createEl.call(this, "div", options) as HTMLDivElement;
  };
  prototype.createSpan = function (this: ObsidianHTMLElement, options: CreateChildOptions = {}) {
    return createEl.call(this, "span", options) as HTMLSpanElement;
  };
  prototype.addClass = function (...classes: string[]) {
    this.classList.add(...classes);
  };
  prototype.empty = function () {
    this.replaceChildren();
  };
}

type MockPlugin = {
  loadData: ReturnType<typeof vi.fn>;
  saveData: ReturnType<typeof vi.fn>;
};

/** Plugin mock where loadData() resolves after a given number of
 *  microtask ticks, letting us simulate race conditions between
 *  concurrent display() invocations or interleaved awaits. */
function makePlugin(initialSettings: Record<string, unknown>, microtaskDelay = 0): MockPlugin {
  let stored = { settings: { ...initialSettings } };
  return {
    loadData: vi.fn(async () => {
      for (let i = 0; i < microtaskDelay; i++) {
        await Promise.resolve();
      }
      return stored;
    }),
    saveData: vi.fn(async (nextData: Record<string, any>) => {
      stored = nextData as typeof stored;
    }),
  };
}

const minimalAdapter = {
  config: {
    columns: [],
    creationColumns: [],
    settingsSchema: [],
    defaultSettings: {},
    itemName: "task",
  },
} as any;

/** Realistic adapter with columns + card flags + enrichment + agent-action
 *  schemas. Rendering this exercises every section/helper in the tab. */
const richAdapter = {
  config: {
    columns: [
      { id: "priority", label: "Priority", folderName: "priority" },
      { id: "active", label: "Active", folderName: "active" },
      { id: "todo", label: "To Do", folderName: "todo" },
      { id: "done", label: "Done", folderName: "archive" },
    ],
    creationColumns: [
      { id: "todo", label: "To Do" },
      { id: "active", label: "Active", default: true },
    ],
    cardFlags: [],
    settingsSchema: [
      { key: "taskBasePath", name: "Task base path", description: "", type: "text", default: "" },
      {
        key: "stateStrategy",
        name: "State strategy",
        description: "",
        type: "dropdown",
        choices: { folder: "Folder", frontmatter: "Frontmatter" },
        default: "folder",
      },
      {
        key: "showCardIndicators",
        name: "Show card indicators",
        description: "",
        type: "toggle",
        default: true,
      },
      {
        key: "taskCardIcons",
        name: "Task card icons",
        description: "",
        type: "toggle",
        default: true,
      },
      {
        key: "autoIconMode",
        name: "Auto icon mode",
        description: "",
        type: "toggle",
        default: false,
      },
      { key: "jiraBaseUrl", name: "Jira base URL", description: "", type: "text", default: "" },
      {
        key: "enrichmentEnabled",
        name: "Enrichment enabled",
        description: "",
        type: "toggle",
        default: false,
      },
      {
        key: "splitTaskProfile",
        name: "Split task profile",
        description: "",
        type: "dropdown",
        choices: "profiles",
        default: "",
      },
    ],
    defaultSettings: {},
    itemName: "task",
  },
} as any;

const mockProfileManager = {
  getProfiles: vi.fn(() => []),
  getButtonProfiles: vi.fn(() => []),
} as any;

/** Flush pending microtasks until the DOM stops changing (bounded). We
 *  wait for the DOM to show growth first (handles slow loadData()
 *  promises), then for 5 consecutive stable ticks. */
async function flushUntilStable(containerEl: HTMLElement, maxTicks = 200): Promise<number> {
  let prev = containerEl.childNodes.length;
  let stableTicks = 0;
  let total = 0;
  let hasGrown = prev > 0;
  while (total < maxTicks && (!hasGrown || stableTicks < 5)) {
    await Promise.resolve();
    total += 1;
    const current = containerEl.childNodes.length;
    if (current !== prev) {
      hasGrown = true;
      stableTicks = 0;
      prev = current;
    } else if (hasGrown) {
      stableTicks += 1;
    }
  }
  return total;
}

/** Capture the visible sequence of sections (h2) and settings (setting-item
 *  name text) in document order. Section headings surface as "## General"
 *  and settings as bare names, so assertions can match declared order. */
function captureSequence(containerEl: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    const el = node as HTMLElement;
    if (el.tagName === "H2") {
      out.push(`## ${el.textContent || ""}`);
    } else if (
      el.classList?.contains("setting-item") &&
      !el.parentElement?.closest(".setting-item")
    ) {
      // Top-level setting-item only (skip nested .setting-item inside
      // dialogs if they bubble up for any reason).
      const nameEl = el.querySelector(".setting-item-name");
      if (nameEl?.textContent) out.push(nameEl.textContent);
    }
    node = walker.nextNode();
  }
  return out;
}

describe("WorkTerminalSettingsTab render ordering (issue #473)", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = "/Users/tester";
    document.body.innerHTML = "";
    installDomHelpers();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.clearAllMocks();
  });

  it("renders section headings strictly in declared order", async () => {
    const plugin = makePlugin({});
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    const headings = Array.from(tab.containerEl.querySelectorAll("h2")).map(
      (h) => h.textContent || "",
    );
    expect(headings).toEqual(["General", "Board & Columns", "Terminal", "Detail view", "Agents"]);
  });

  it("does not interleave Agents section rows into the Detail view section", async () => {
    // Regression guard for the original bug: an async helper could resolve
    // mid-render and append an Agents-section setting between Placement and
    // Auto-close. The specific textarea that triggered the symptom has been
    // removed (see #472), but the invariant - no Agents rows in the middle
    // of the Detail view section - must still hold.
    const plugin = makePlugin({ "core.detailViewPlacement": "split" });
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    const sequence = captureSequence(tab.containerEl);
    const detailHeadingIdx = sequence.indexOf("## Detail view");
    const agentsHeadingIdx = sequence.indexOf("## Agents");

    expect(detailHeadingIdx).toBeGreaterThan(-1);
    expect(agentsHeadingIdx).toBeGreaterThan(detailHeadingIdx);
    // Detail view rows must be contiguous under their heading - no Agents
    // rows may appear between the Detail view heading and the Agents heading.
    const between = sequence.slice(detailHeadingIdx + 1, agentsHeadingIdx);
    const agentsRowNames = ["Manage agent profiles", "Background enrichment", "Agent actions"];
    for (const row of agentsRowNames) {
      expect(between).not.toContain(row);
    }
  });

  it("keeps Detail view settings contiguous under their heading", async () => {
    const plugin = makePlugin({ "core.detailViewPlacement": "split" });
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    const sequence = captureSequence(tab.containerEl);
    const detailIdx = sequence.indexOf("## Detail view");
    const agentsIdx = sequence.indexOf("## Agents");
    const between = sequence.slice(detailIdx + 1, agentsIdx);
    // For split placement, the section contains exactly:
    //   Placement, Auto-close on selection change, Apply readable
    //   line-width override to split, Split direction.
    expect(between).toEqual([
      "Placement",
      "Auto-close on selection change",
      "Apply readable line-width override to split",
      "Split direction",
    ]);
  });

  it("renders Agents section entries in declared order", async () => {
    const plugin = makePlugin({});
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    const sequence = captureSequence(tab.containerEl);
    const agentsIdx = sequence.indexOf("## Agents");
    const tail = sequence.slice(agentsIdx + 1);
    expect(tail).toEqual(["Manage agent profiles", "Background enrichment", "Agent actions"]);
  });

  it("stays in declared order when loadData() is delayed by many microtasks", async () => {
    const plugin = makePlugin({ "core.detailViewPlacement": "split" }, 10);
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl, 200);

    const headings = Array.from(tab.containerEl.querySelectorAll("h2")).map(
      (h) => h.textContent || "",
    );
    expect(headings).toEqual(["General", "Board & Columns", "Terminal", "Detail view", "Agents"]);

    const sequence = captureSequence(tab.containerEl);
    const detailIdx = sequence.indexOf("## Detail view");
    const agentsIdx = sequence.indexOf("## Agents");
    const manageProfilesIdx = sequence.indexOf("Manage agent profiles");
    expect(detailIdx).toBeLessThan(agentsIdx);
    // First Agents row must follow the Agents heading, not leak into Detail view.
    expect(manageProfilesIdx).toBeGreaterThan(agentsIdx);
  });

  it("produces identical sequences on back-to-back display() calls", async () => {
    const plugin = makePlugin({ "core.detailViewPlacement": "split" }, 2);
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);
    const first = captureSequence(tab.containerEl);

    tab.display();
    await flushUntilStable(tab.containerEl);
    const second = captureSequence(tab.containerEl);

    expect(second).toEqual(first);
    // No duplicates from the re-render - each heading appears exactly once.
    const headings = second.filter((entry) => entry.startsWith("## "));
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("abandons a stale render if display() fires again before loadData() resolves", async () => {
    // First call uses a slow loadData; second call uses a fresh instant
    // one. With the renderSeq guard, the stale first call must NOT append
    // to containerEl after the second call has emptied and re-rendered.
    const plugin = makePlugin({ "core.detailViewPlacement": "split" }, 5);
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );

    tab.display();
    // Immediately trigger a second display() before the first await chain
    // finishes. The second call resets renderSeq and re-starts.
    tab.display();

    await flushUntilStable(tab.containerEl, 200);

    const headings = Array.from(tab.containerEl.querySelectorAll("h2")).map(
      (h) => h.textContent || "",
    );
    // Exactly one copy of each section heading - no duplicate rendering
    // caused by both display() calls appending their output.
    expect(headings).toEqual(["General", "Board & Columns", "Terminal", "Detail view", "Agents"]);
  });

  it("DOM stops growing once the initial render is stable (no post-return re-entry)", async () => {
    const plugin = makePlugin({ "core.detailViewPlacement": "split" });
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    const sizeAfterRender = tab.containerEl.childNodes.length;
    // Several more microtasks - no helper should be scheduling extra
    // appends behind the initial render pass.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(tab.containerEl.childNodes.length).toBe(sizeAfterRender);
  });

  it("renders adapter settings in schema-declared order within the General section", async () => {
    const plugin = makePlugin({});
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    const sequence = captureSequence(tab.containerEl);
    const generalIdx = sequence.indexOf("## General");
    const boardIdx = sequence.indexOf("## Board & Columns");
    const generalBody = sequence.slice(generalIdx + 1, boardIdx);

    // The General section puts taskBasePath + stateStrategy first, then
    // core dropdowns, then card-indicator toggles, then jiraBaseUrl, then
    // lifecycle toggles. Check the ordering of the key anchors.
    const expectOrder = [
      "Task base path",
      "State strategy",
      "View mode",
      "Recent activity threshold",
      "Card display mode",
      "Show card indicators",
      "Task card icons",
      "Auto icon mode",
      "Jira base URL",
      "Keep sessions alive when tab is closed",
      "Enrichment failure logs",
      "Expose debug API",
      "Reset guided tour",
    ];
    let cursor = 0;
    for (const label of expectOrder) {
      const found = generalBody.indexOf(label, cursor);
      expect(found, `expected "${label}" after position ${cursor}`).toBeGreaterThanOrEqual(cursor);
      cursor = found;
    }
  });

  it("re-render after simulated settings change preserves declared order", async () => {
    const plugin = makePlugin({ "core.detailViewPlacement": "split" });
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      richAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    // Simulate a user change: update stored settings to flip the
    // placement to "tab" (which prunes width-override + split-direction).
    const data = await plugin.loadData();
    data!.settings["core.detailViewPlacement"] = "tab";
    await plugin.saveData(data!);

    tab.display();
    await flushUntilStable(tab.containerEl);

    const sequence = captureSequence(tab.containerEl);
    const detailIdx = sequence.indexOf("## Detail view");
    const agentsIdx = sequence.indexOf("## Agents");
    const detailBody = sequence.slice(detailIdx + 1, agentsIdx);
    // With placement=tab, only Placement + Auto-close remain.
    expect(detailBody).toEqual(["Placement", "Auto-close on selection change"]);
  });

  it("works for a minimal adapter (no columns, no card flags)", async () => {
    const plugin = makePlugin({});
    const tab = new WorkTerminalSettingsTab(
      {} as any,
      plugin as any,
      minimalAdapter,
      mockProfileManager,
    );
    tab.display();
    await flushUntilStable(tab.containerEl);

    // Board & Columns section is omitted when the adapter contributes
    // nothing to it, and the remaining sections stay in order.
    const headings = Array.from(tab.containerEl.querySelectorAll("h2")).map(
      (h) => h.textContent || "",
    );
    expect(headings).toEqual(["General", "Terminal", "Detail view", "Agents"]);
  });
});
