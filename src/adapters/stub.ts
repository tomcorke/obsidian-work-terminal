/**
 * Stub adapter for framework development and testing.
 * Returns minimal implementations of all required interfaces.
 * Will be replaced by the task-agent adapter in Phase 4.
 */
import type { App, TFile, MenuItem } from "obsidian";
import {
  BaseAdapter,
  type WorkItem,
  type WorkItemParser,
  type WorkItemMover,
  type CardRenderer,
  type WorkItemPromptBuilder,
  type CardActionContext,
  type PluginConfig,
} from "../core/interfaces";

const STUB_COLUMNS = [
  { id: "active", label: "Active", folderName: "active" },
  { id: "todo", label: "To Do", folderName: "todo" },
  { id: "done", label: "Done", folderName: "done" },
];

class StubParser implements WorkItemParser {
  basePath: string;

  constructor(_app: App, basePath: string) {
    this.basePath = basePath;
  }

  parse(_file: TFile): WorkItem | null {
    return null;
  }

  async loadAll(): Promise<WorkItem[]> {
    return [];
  }

  groupByColumn(items: WorkItem[]): Record<string, WorkItem[]> {
    const groups: Record<string, WorkItem[]> = {};
    for (const col of STUB_COLUMNS) {
      groups[col.id] = items.filter((i) => i.state === col.id);
    }
    return groups;
  }

  isItemFile(_path: string): boolean {
    return false;
  }
}

class StubMover implements WorkItemMover {
  async move(_file: TFile, _targetColumnId: string): Promise<boolean> {
    return true;
  }
}

class StubCardRenderer implements CardRenderer {
  render(item: WorkItem, _ctx: CardActionContext): HTMLElement {
    const el = document.createElement("div");
    el.addClass("wt-card");
    el.textContent = item.title;
    return el;
  }

  getContextMenuItems(_item: WorkItem, _ctx: CardActionContext): MenuItem[] {
    return [];
  }
}

class StubPromptBuilder implements WorkItemPromptBuilder {
  buildPrompt(item: WorkItem, _fullPath: string): string {
    return `Work item: ${item.title}`;
  }
}

export class StubAdapter extends BaseAdapter {
  config: PluginConfig = {
    columns: STUB_COLUMNS,
    creationColumns: [
      { id: "todo", label: "To Do", default: true },
      { id: "active", label: "Active" },
    ],
    settingsSchema: [],
    defaultSettings: {},
    itemName: "item",
  };

  createParser(app: App, basePath: string, _settings?: Record<string, unknown>): WorkItemParser {
    return new StubParser(app, basePath);
  }

  createMover(_app: App, _basePath: string, _settings?: Record<string, unknown>): WorkItemMover {
    return new StubMover();
  }

  createCardRenderer(): CardRenderer {
    return new StubCardRenderer();
  }

  createPromptBuilder(): WorkItemPromptBuilder {
    return new StubPromptBuilder();
  }
}
