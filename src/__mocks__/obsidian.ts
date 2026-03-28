// Minimal Obsidian stub for vitest environments that cannot resolve the real package.
// The real obsidian package is available in the node environment; this file is used
// when the jsdom environment needs to resolve the module at transform time.

export class Notice {
  constructor(_message: string) {}
}

export class Modal {
  app: unknown;
  contentEl: HTMLElement | null = null;
  constructor(app: unknown) {
    this.app = app;
    if (typeof document !== "undefined") {
      this.contentEl = document.createElement("div");
    }
  }
  open() {}
  close() {}
}

export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class MarkdownView {}
export class WorkspaceLeaf {}
export class TFile {}
export class TFolder {}
