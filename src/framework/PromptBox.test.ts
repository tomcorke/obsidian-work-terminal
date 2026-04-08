// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptBox } from "./PromptBox";
import type { AdapterBundle } from "../core/interfaces";

type CreateChildOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  value?: string;
  [key: string]: unknown;
};
type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  createDiv(options?: CreateChildOptions): HTMLDivElement;
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: CreateChildOptions,
  ): HTMLElementTagNameMap[K];
};

beforeAll(() => {
  const prototype = HTMLElement.prototype as ObsidianHTMLElementPrototype;

  prototype.createDiv = function (options?: CreateChildOptions) {
    const el = document.createElement("div");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options ?? {})) {
      if (key === "cls" || key === "text" || key === "attr" || value == null) continue;
      if (key in el) {
        (el as Record<string, unknown>)[key] = value;
      }
    }
    if (options?.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        if (key in el) {
          (el as Record<string, unknown>)[key] = value;
        }
        el.setAttribute(key, value);
      }
    }
    this.appendChild(el);
    return el;
  };

  prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: CreateChildOptions,
  ) {
    const el = document.createElement(tag);
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options ?? {})) {
      if (key === "cls" || key === "text" || key === "attr" || value == null) continue;
      if (key in el) {
        (el as Record<string, unknown>)[key] = value;
      }
    }
    if (options?.attr) {
      for (const [key, value] of Object.entries(options.attr)) {
        if (key in el) {
          (el as Record<string, unknown>)[key] = value;
        }
        el.setAttribute(key, value);
      }
    }
    this.appendChild(el);
    return el;
  };
});

function flushPromises(): Promise<void> {
  return Promise.resolve();
}

function makeAdapter(
  onItemCreated: AdapterBundle["onItemCreated"] = vi.fn().mockResolvedValue(undefined),
): AdapterBundle {
  return {
    config: {
      itemName: "task",
      creationColumns: [
        { id: "todo", label: "Todo", default: true },
        { id: "doing", label: "Doing" },
      ],
      columns: [],
      settingsSchema: [],
      defaultSettings: {},
    },
    createParser: vi.fn() as any,
    createMover: vi.fn() as any,
    createCardRenderer: vi.fn() as any,
    createPromptBuilder: vi.fn() as any,
    onItemCreated,
  };
}

function makePlugin(profileId?: string, profile?: Record<string, unknown>) {
  return {
    profileManager: {
      getProfile: vi.fn((requestedProfileId: string) =>
        requestedProfileId === profileId ? profile : undefined,
      ),
    },
  } as any;
}

function createPromptBox(options?: {
  adapter?: AdapterBundle;
  plugin?: any;
  settings?: Record<string, unknown>;
}) {
  const parentEl = document.createElement("div");
  document.body.appendChild(parentEl);
  const onPlaceholderAdd = vi.fn();
  const onPlaceholderResolve = vi.fn();
  const onNewItemCreated = vi.fn();
  const adapter = options?.adapter ?? makeAdapter();
  const plugin = options?.plugin ?? makePlugin();
  const settings = options?.settings ?? {};

  new PromptBox(
    parentEl,
    adapter,
    plugin,
    settings,
    onPlaceholderAdd,
    onPlaceholderResolve,
    onNewItemCreated,
  );

  return {
    parentEl,
    adapter,
    plugin,
    onPlaceholderAdd,
    onPlaceholderResolve,
    onNewItemCreated,
    toggleBtn: parentEl.querySelector(".wt-prompt-toggle") as HTMLButtonElement,
    expandedEl: parentEl.querySelector(".wt-prompt-expanded") as HTMLDivElement,
    inputEl: parentEl.querySelector(".wt-prompt-input") as HTMLTextAreaElement,
    columnSelect: parentEl.querySelector(".wt-prompt-column-select") as HTMLSelectElement,
    sendBtn: parentEl.querySelector(".wt-prompt-send") as HTMLButtonElement,
  };
}

describe("PromptBox", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders collapsed by default and expands on toggle", () => {
    const { toggleBtn, expandedEl, inputEl } = createPromptBox();

    expect(toggleBtn.textContent).toBe("+ New task");
    expect(expandedEl.style.display).toBe("none");

    toggleBtn.click();

    expect(expandedEl.style.display).toBe("");
    expect(document.activeElement).toBe(inputEl);
  });

  it("submits trimmed input, adds a placeholder, and resolves immediately when no card mapping is returned", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123456789);
    const onItemCreated = vi.fn().mockResolvedValue(undefined);
    const { inputEl, columnSelect, sendBtn, onPlaceholderAdd, onPlaceholderResolve, adapter } =
      createPromptBox({
        adapter: makeAdapter(onItemCreated),
        settings: { "adapter.foo": "bar" },
      });

    inputEl.value = "  Ship tests  ";
    columnSelect.value = "doing";

    sendBtn.click();
    await flushPromises();

    expect(onPlaceholderAdd).toHaveBeenCalledWith("__pending_123456789");
    expect(adapter.onItemCreated).toHaveBeenCalledWith("Ship tests", {
      "adapter.foo": "bar",
      _columnId: "doing",
      _placeholderPath: "__pending_123456789",
    });
    expect(inputEl.value).toBe("");
    expect(onPlaceholderResolve).toHaveBeenCalledWith("__pending_123456789", true);
  });

  it("maps configured enrichment profiles into adapter settings", async () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const onItemCreated = vi.fn().mockResolvedValue(undefined);
    const profile = {
      agentType: "custom",
      name: "Copilot",
      command: "copilot",
      arguments: "--chat",
      defaultCwd: "~/repo",
      promptInjectionMode: "flag",
      promptFlag: "--prompt",
    };
    const plugin = makePlugin("profile-1", profile);
    const { inputEl, sendBtn, adapter } = createPromptBox({
      adapter: makeAdapter(onItemCreated),
      plugin,
      settings: { "adapter.enrichmentProfile": "profile-1" },
    });

    inputEl.value = "PromptBox profile test";
    sendBtn.click();
    await flushPromises();

    expect(adapter.onItemCreated).toHaveBeenCalledWith("PromptBox profile test", {
      "adapter.enrichmentProfile": "profile-1",
      _columnId: "todo",
      _placeholderPath: "__pending_42",
      _enrichmentProfile: {
        command: "copilot",
        args: "--chat",
        cwd: "~/repo",
        agentName: "Copilot",
        promptMode: "flag",
        promptFlag: "--prompt",
      },
    });
    expect(plugin.profileManager.getProfile).toHaveBeenCalledWith("profile-1");
  });

  it("defaults custom enrichment profiles without prompt injection mode to positional", async () => {
    vi.spyOn(Date, "now").mockReturnValue(43);
    const onItemCreated = vi.fn().mockResolvedValue(undefined);
    const profile = {
      agentType: "custom",
      name: "Pi",
      command: "pi",
      arguments: "--mode text",
      defaultCwd: "~/repo",
    };
    const plugin = makePlugin("profile-2", profile);
    const { inputEl, sendBtn, adapter } = createPromptBox({
      adapter: makeAdapter(onItemCreated),
      plugin,
      settings: { "adapter.enrichmentProfile": "profile-2" },
    });

    inputEl.value = "Custom enrichment profile test";
    sendBtn.click();
    await flushPromises();

    expect(adapter.onItemCreated).toHaveBeenCalledWith("Custom enrichment profile test", {
      "adapter.enrichmentProfile": "profile-2",
      _columnId: "todo",
      _placeholderPath: "__pending_43",
      _enrichmentProfile: {
        command: "pi",
        args: "--mode text",
        cwd: "~/repo",
        agentName: "Pi",
        promptMode: "positional",
        promptFlag: undefined,
      },
    });
  });

  it("notifies the list when the adapter returns a real item mapping", async () => {
    vi.spyOn(Date, "now").mockReturnValue(77);
    const enrichmentDone = Promise.resolve();
    const onItemCreated = vi.fn().mockResolvedValue({
      id: "task-123",
      columnId: "todo",
      enrichmentDone,
    });
    const { inputEl, sendBtn, onNewItemCreated, onPlaceholderResolve } = createPromptBox({
      adapter: makeAdapter(onItemCreated),
    });

    inputEl.value = "Create mapped task";
    sendBtn.click();
    await flushPromises();

    expect(onNewItemCreated).toHaveBeenCalledWith(
      "task-123",
      "todo",
      "__pending_77",
      enrichmentDone,
    );
    expect(onPlaceholderResolve).not.toHaveBeenCalled();
  });

  it("submits on Enter, but not on Shift+Enter, and always stops propagation", async () => {
    const onItemCreated = vi.fn().mockResolvedValue(undefined);
    const { inputEl } = createPromptBox({
      adapter: makeAdapter(onItemCreated),
    });
    const parentKeydown = vi.fn();

    inputEl.value = "Keyboard submit";
    document.body.appendChild(inputEl.parentElement!.parentElement!);
    inputEl.parentElement!.parentElement!.addEventListener("keydown", parentKeydown);

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
    });
    inputEl.dispatchEvent(shiftEnter);
    await flushPromises();

    expect(onItemCreated).not.toHaveBeenCalled();
    expect(parentKeydown).not.toHaveBeenCalled();

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    inputEl.dispatchEvent(enter);
    await flushPromises();

    expect(enter.defaultPrevented).toBe(true);
    expect(onItemCreated).toHaveBeenCalledTimes(1);
    expect(parentKeydown).not.toHaveBeenCalled();
  });

  it("ignores blank titles and resolves failures as unsuccessful placeholders", async () => {
    vi.spyOn(Date, "now").mockReturnValue(555);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onItemCreated = vi.fn().mockRejectedValue(new Error("boom"));
    const { inputEl, sendBtn, onPlaceholderAdd, onPlaceholderResolve } = createPromptBox({
      adapter: makeAdapter(onItemCreated),
    });

    inputEl.value = "   ";
    sendBtn.click();
    await flushPromises();

    expect(onPlaceholderAdd).not.toHaveBeenCalled();

    inputEl.value = "Will fail";
    sendBtn.click();
    await flushPromises();

    expect(onPlaceholderAdd).toHaveBeenCalledWith("__pending_555");
    expect(onPlaceholderResolve).toHaveBeenCalledWith("__pending_555", false);
    expect(consoleError).toHaveBeenCalledWith(
      "[work-terminal] Item creation failed:",
      expect.any(Error),
    );
  });
});
