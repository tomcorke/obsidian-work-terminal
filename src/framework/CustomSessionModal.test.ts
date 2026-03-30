import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { CustomSessionModal } from "./CustomSessionModal";
import type { ClosedSessionEntry } from "../core/session/RecentlyClosedStore";
import type { CustomSessionConfig } from "./CustomSessionConfig";

type DropdownComponent = {
  addOption: (value: string, label: string) => DropdownComponent;
  setValue: (value: string) => DropdownComponent;
  onChange: (handler: (value: string) => void) => DropdownComponent;
};

type TextComponent = {
  inputEl: HTMLInputElement;
  setPlaceholder: (value: string) => TextComponent;
  setValue: (value: string) => TextComponent;
  onChange: (handler: (value: string) => void) => TextComponent;
};

type TextAreaComponent = {
  inputEl: HTMLTextAreaElement;
  setPlaceholder: (value: string) => TextAreaComponent;
  setValue: (value: string) => TextAreaComponent;
  onChange: (handler: (value: string) => void) => TextAreaComponent;
};

declare global {
  interface HTMLElement {
    createEl: (
      tag: string,
      options?: { cls?: string; text?: string; attr?: Record<string, string> },
    ) => HTMLElement;
    createDiv: (options?: { cls?: string; text?: string; attr?: Record<string, string> }) => HTMLDivElement;
    createSpan: (
      options?: { cls?: string; text?: string; attr?: Record<string, string> },
    ) => HTMLSpanElement;
    addClass: (...classes: string[]) => void;
    removeClass: (...classes: string[]) => void;
    empty: () => void;
  }
}

vi.mock("obsidian", () => {
  class App {}

  class Modal {
    app: unknown;
    contentEl: HTMLElement;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
    }

    open() {}
    close() {}
  }

  class Setting {
    settingEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
      this.settingEl = document.createElement("div");
      containerEl.appendChild(this.settingEl);
    }

    setName() {
      return this;
    }

    setDesc() {
      return this;
    }

    addDropdown(
      callback: (dropdown: DropdownComponent) => void,
    ) {
      const selectEl = document.createElement("select");
      this.settingEl.appendChild(selectEl);
      const dropdown: DropdownComponent = {
        addOption(value: string, label: string) {
          const optionEl = document.createElement("option");
          optionEl.value = value;
          optionEl.textContent = label;
          selectEl.appendChild(optionEl);
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

    addText(
      callback: (text: TextComponent) => void,
    ) {
      const inputEl = document.createElement("input");
      this.settingEl.appendChild(inputEl);
      const text: TextComponent = {
        inputEl,
        setPlaceholder(value: string) {
          inputEl.placeholder = value;
          return text;
        },
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
      callback: (text: TextAreaComponent) => void,
    ) {
      const inputEl = document.createElement("textarea");
      this.settingEl.appendChild(inputEl);
      const text: TextAreaComponent = {
        inputEl,
        setPlaceholder(value: string) {
          inputEl.placeholder = value;
          return text;
        },
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
  }

  return { App, Modal, Setting };
});

type DomGlobals = {
  window: Window & typeof globalThis;
  document: Document;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  Node: typeof Node;
};

function installDomHelpers(globals: DomGlobals) {
  const { HTMLElement } = globals;
  const createEl = function (
    this: HTMLElement,
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    const el = globals.document.createElement(tag) as HTMLElement;
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

  HTMLElement.prototype.createEl = createEl;
  HTMLElement.prototype.createDiv = function (
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return createEl.call(this, "div", options);
  };
  HTMLElement.prototype.createSpan = function (
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return createEl.call(this, "span", options);
  };
  HTMLElement.prototype.addClass = function (...classes: string[]) {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.removeClass = function (...classes: string[]) {
    this.classList.remove(...classes);
  };
  HTMLElement.prototype.empty = function () {
    this.replaceChildren();
  };
}

const defaultConfig: CustomSessionConfig = {
  sessionType: "claude",
  cwd: "~",
  extraArgs: "",
  label: "",
};

const closedSession: ClosedSessionEntry = {
  sessionType: "claude",
  label: "Pairing session",
  claudeSessionId: "session-123",
  closedAt: Date.now() - 60_000,
  itemId: "item-1",
};

describe("CustomSessionModal", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Element", dom.window.Element);
    vi.stubGlobal("Node", dom.window.Node);
    installDomHelpers({
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it("defaults to the new session view even when recent sessions exist", () => {
    const modal = new CustomSessionModal(
      {} as never,
      defaultConfig,
      vi.fn(),
      [closedSession],
      vi.fn(),
    );

    modal.onOpen();

    expect(modal.contentEl.querySelector("h3")?.textContent).toBe("Custom session");
    expect(
      modal.contentEl.querySelector(".wt-custom-spawn-tab-active")?.textContent,
    ).toBe("New session");
    expect(modal.contentEl.textContent).not.toContain("Restore recent sessions");
  });

  it("switches to restore recent when the tab is clicked and restores the chosen session", () => {
    const onRestore = vi.fn();
    const modal = new CustomSessionModal(
      {} as never,
      defaultConfig,
      vi.fn(),
      [closedSession],
      onRestore,
    );

    modal.onOpen();

    const restoreTab = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>(".wt-custom-spawn-tab"),
    ).find((button) => button.textContent === "Restore recent");
    restoreTab?.click();

    expect(modal.contentEl.querySelector("h3")?.textContent).toBe("Restore recent sessions");

    modal.contentEl.querySelector<HTMLButtonElement>(".wt-recently-closed-row")?.click();

    expect(onRestore).toHaveBeenCalledWith(closedSession);
  });

  it("omits the restore tabs when there are no recent sessions", () => {
    const modal = new CustomSessionModal({} as never, defaultConfig, vi.fn(), []);

    modal.onOpen();

    expect(modal.contentEl.querySelector(".wt-custom-spawn-tabs")).toBeNull();
    expect(modal.contentEl.querySelector("h3")?.textContent).toBe("Custom session");
  });
});
