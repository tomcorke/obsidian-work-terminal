// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, AgentType } from "../core/agents/AgentProfile";

const { NoticeMock } = vi.hoisted(() => ({
  NoticeMock: vi.fn(),
}));

vi.mock("obsidian", () => {
  class App {}

  class Modal {
    app: unknown;
    contentEl: HTMLElement;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement("div");
    }
    open() {
      (this as any).onOpen?.();
    }
    close() {
      (this as any).onClose?.();
    }
  }

  class Setting {
    settingEl: HTMLDivElement;
    nameEl: HTMLDivElement;
    descEl: HTMLDivElement;
    controlEl: HTMLDivElement;

    constructor(containerEl: HTMLElement) {
      this.settingEl = document.createElement("div");
      this.nameEl = document.createElement("div");
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
        setPlaceholder: (value: string) => any;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("input");
      this.controlEl.appendChild(inputEl);
      const text = {
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
      callback: (text: {
        inputEl: HTMLTextAreaElement;
        setPlaceholder: (value: string) => any;
        setValue: (value: string) => any;
        onChange: (handler: (value: string) => void) => any;
      }) => void,
    ) {
      const inputEl = document.createElement("textarea");
      this.controlEl.appendChild(inputEl);
      const text = {
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

  return { App, Modal, Notice: NoticeMock, Setting };
});

type CreateChildOptions = { cls?: string; text?: string; attr?: Record<string, string> };

type ObsidianHTMLElementPrototype = typeof HTMLElement.prototype & {
  empty(): void;
  addClass(cls: string): HTMLElement;
  createDiv(options?: CreateChildOptions): HTMLDivElement;
  createSpan(options?: CreateChildOptions): HTMLSpanElement;
  createEl(tag: string, options?: CreateChildOptions): HTMLElement;
  setAttr(key: string, value: string): HTMLElement;
  insertAfter(node: Node, referenceNode: Node): Node;
};

beforeAll(() => {
  const prototype = HTMLElement.prototype as ObsidianHTMLElementPrototype;

  prototype.empty = function () {
    this.innerHTML = "";
  };
  prototype.addClass = function (cls: string) {
    this.classList.add(...cls.split(" "));
    return this;
  };
  prototype.createDiv = function (options?: CreateChildOptions) {
    const el = document.createElement("div");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
  prototype.createSpan = function (options?: CreateChildOptions) {
    const el = document.createElement("span");
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  };
  prototype.createEl = function (tag: string, options?: CreateChildOptions) {
    const el = document.createElement(tag);
    if (options?.cls) el.classList.add(...options.cls.split(" "));
    if (options?.text) el.textContent = options.text;
    if (options?.attr) {
      for (const [k, v] of Object.entries(options.attr)) el.setAttribute(k, v);
    }
    this.appendChild(el);
    return el;
  };
  prototype.setAttr = function (key: string, value: string) {
    this.setAttribute(key, value);
    return this;
  };
  // insertAfter polyfill (Obsidian HTMLElement augmentation)
  prototype.insertAfter = function (node: Node, referenceNode: Node) {
    const parent = referenceNode.parentNode;
    if (!parent) throw new Error("referenceNode has no parent");
    parent.insertBefore(node, referenceNode.nextSibling);
    return node;
  };

  // CSS.supports is not available in jsdom
  if (!globalThis.CSS) {
    (globalThis as Record<string, unknown>).CSS = { supports: () => true };
  } else if (!CSS.supports) {
    (CSS as Record<string, unknown>).supports = () => true;
  }
});

// Import AFTER the vi.mock is set up so the SUT binds to the mocked module.
import { AgentProfileEditModal } from "./AgentProfileModal";

function makeProfile(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    agentType: overrides.agentType ?? ("claude" as AgentType),
    command: overrides.command ?? "",
    defaultCwd: overrides.defaultCwd ?? "",
    arguments: overrides.arguments ?? "",
    contextPrompt: overrides.contextPrompt ?? "",
    useContext: overrides.useContext ?? false,
    suppressAdapterPrompt: overrides.suppressAdapterPrompt ?? false,
    button: overrides.button ?? { enabled: false, label: overrides.name ?? overrides.id },
    sortOrder: overrides.sortOrder ?? 0,
  };
}

function getDeleteButton(modal: AgentProfileEditModal): HTMLButtonElement | null {
  const el = (modal as any).contentEl as HTMLElement;
  const buttons = el.querySelectorAll<HTMLButtonElement>("button");
  for (const btn of Array.from(buttons)) {
    if (btn.textContent === "Delete") return btn;
  }
  return null;
}

describe("AgentProfileEditModal delete guard", () => {
  beforeEach(() => {
    NoticeMock.mockClear();
  });

  it("evaluates the guard against the persisted profile, not the draft", () => {
    const claude = makeProfile({ id: "c1", name: "Claude", agentType: "claude" });
    const guardSpy = vi.fn(() => null);
    const modal = new AgentProfileEditModal(
      {} as any,
      claude,
      vi.fn(),
      vi.fn(),
      undefined,
      guardSpy as any,
    );
    modal.open();

    // Guard is called once at render time with the persisted profile snapshot.
    expect(guardSpy).toHaveBeenCalledTimes(1);
    const renderedWith = guardSpy.mock.calls[0][0] as AgentProfile;
    expect(renderedWith.id).toBe("c1");
    expect(renderedWith.agentType).toBe("claude");

    // The argument passed to the guard must NOT be the live draft. Mutating
    // `this.draft` should not influence what the guard sees on re-invocation.
    (modal as any).draft.agentType = "shell";
    (modal as any).draft.id = "tampered";

    // Click the Delete button - guard is re-invoked inside the handler.
    const deleteBtn = getDeleteButton(modal)!;
    const originalConfirm = window.confirm;
    window.confirm = () => false;
    try {
      deleteBtn.click();
    } finally {
      window.confirm = originalConfirm;
    }
    // Guard was re-invoked at click time and still received the persisted
    // profile, not the tampered draft.
    const laterCallProfile = guardSpy.mock.calls[guardSpy.mock.calls.length - 1][0] as AgentProfile;
    expect(laterCallProfile.agentType).toBe("claude");
    expect(laterCallProfile.id).toBe("c1");
  });

  it("changing draft.agentType away from 'claude' does not unlock Delete", () => {
    const claude = makeProfile({ id: "c1", name: "Claude", agentType: "claude" });

    // Guard mimicking the real "last Claude profile" rule - blocks when
    // the persisted profile is Claude.
    const guard = (p: AgentProfile) => (p.agentType === "claude" ? "blocked" : null);

    const onDelete = vi.fn();
    const modal = new AgentProfileEditModal(
      {} as any,
      claude,
      vi.fn(),
      onDelete,
      undefined,
      guard as any,
    );
    modal.open();

    // Button is rendered with aria-disabled and tooltip.
    let deleteBtn = getDeleteButton(modal)!;
    expect(deleteBtn.getAttribute("aria-disabled")).toBe("true");
    expect(deleteBtn.title).toBe("blocked");

    // Simulate user switching the agent type dropdown to "shell". Re-render
    // is triggered by the SUT's onChange callback.
    const selects = (modal as any).contentEl.querySelectorAll(
      "select",
    ) as NodeListOf<HTMLSelectElement>;
    // The first dropdown is the agent type selector (order: agent type,
    // button icon, border style).
    const agentTypeSelect = selects[0];
    agentTypeSelect.value = "shell";
    agentTypeSelect.dispatchEvent(new Event("change"));

    // After re-render the Delete button should still be blocked because the
    // guard is evaluated against the *persisted* profile, not the draft.
    deleteBtn = getDeleteButton(modal)!;
    expect(deleteBtn.getAttribute("aria-disabled")).toBe("true");
    expect(deleteBtn.title).toBe("blocked");

    // Clicking must NOT call onDelete - the click handler re-checks the
    // guard and surfaces a Notice instead.
    deleteBtn.click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(NoticeMock).toHaveBeenCalledWith("blocked");
  });

  it("uses aria-disabled instead of the native disabled attribute so click fires", () => {
    const claude = makeProfile({ id: "c1", name: "Claude", agentType: "claude" });
    const guard = () => "cannot delete";

    const onDelete = vi.fn();
    const modal = new AgentProfileEditModal(
      {} as any,
      claude,
      vi.fn(),
      onDelete,
      undefined,
      guard as any,
    );
    modal.open();

    const deleteBtn = getDeleteButton(modal)!;
    // Native disabled MUST NOT be set (it would swallow click events).
    expect(deleteBtn.disabled).toBe(false);
    expect(deleteBtn.getAttribute("aria-disabled")).toBe("true");
    expect(deleteBtn.title).toBe("cannot delete");

    // Click fires and is blocked via Notice.
    deleteBtn.click();
    expect(NoticeMock).toHaveBeenCalledWith("cannot delete");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("click handler re-checks the guard even if blockedReason was captured earlier", () => {
    const claude = makeProfile({ id: "c1", name: "Claude", agentType: "claude" });
    // First call returns null (allowed at render), subsequent calls block.
    let callCount = 0;
    const guard = vi.fn(() => {
      callCount++;
      return callCount === 1 ? null : "now-blocked";
    });

    const onDelete = vi.fn();
    const modal = new AgentProfileEditModal(
      {} as any,
      claude,
      vi.fn(),
      onDelete,
      undefined,
      guard as any,
    );
    modal.open();

    const deleteBtn = getDeleteButton(modal)!;
    // Not blocked at render time - no aria-disabled.
    expect(deleteBtn.getAttribute("aria-disabled")).toBeNull();

    // confirm() would fire if we got past the guard - stub it out.
    const originalConfirm = window.confirm;
    window.confirm = () => false;
    try {
      deleteBtn.click();
    } finally {
      window.confirm = originalConfirm;
    }

    // Guard ran at click time and blocked - Notice surfaced, onDelete not
    // called.
    expect(guard).toHaveBeenCalledTimes(2);
    expect(NoticeMock).toHaveBeenCalledWith("now-blocked");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("when unblocked, Delete passes the persisted profile id to onDelete (not draft.id)", () => {
    const claude = makeProfile({ id: "persisted-id", name: "Claude", agentType: "claude" });
    const guard = () => null;

    const onDelete = vi.fn();
    const modal = new AgentProfileEditModal(
      {} as any,
      claude,
      vi.fn(),
      onDelete,
      undefined,
      guard as any,
    );
    modal.open();

    // Attempt to tamper with draft.id. Guard still uses persisted.
    (modal as any).draft.id = "tampered-id";

    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const deleteBtn = getDeleteButton(modal)!;
      deleteBtn.click();
    } finally {
      window.confirm = originalConfirm;
    }

    expect(onDelete).toHaveBeenCalledWith("persisted-id");
  });
});
