import type { App } from "obsidian";
import { spawnHeadlessClaude } from "../../core/claude/HeadlessClaude";
import { generateTaskContent, generatePendingFilename } from "./TaskFileTemplate";
import type { SplitSource } from "./TaskFileTemplate";
import { expandTilde } from "../../core/utils";
import { STATE_FOLDER_MAP, type KanbanColumn } from "./types";

const RENAME_INSTRUCTION =
  `After updating the task, rename the file to match the convention ` +
  `TASK-YYYYMMDD-HHMM-slugified-title.md (use the existing date prefix, ` +
  `replace the "pending-XXXXXXXX" segment with a slug of the final title).`;

function resolveVaultPath(app: App): string {
  const adapter = app.vault.adapter as any;
  let vaultPath: string = adapter.basePath || adapter.getBasePath?.() || "";
  if (vaultPath.startsWith("~/") || vaultPath === "~") {
    vaultPath = expandTilde(vaultPath);
  }
  return vaultPath;
}

function resolveFullPath(app: App, vaultRelativePath: string): string {
  return `${resolveVaultPath(app)}/${vaultRelativePath}`;
}

export interface ItemCreatedResult {
  id: string;
  columnId: string;
  enrichmentDone: Promise<void>;
}

export async function handleItemCreated(
  app: App,
  title: string,
  settings: Record<string, any>,
): Promise<ItemCreatedResult> {
  const columnId = (settings._columnId || "todo") as KanbanColumn;
  const basePath = settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
  const claudeCommand = settings["core.claudeCommand"] || "claude";
  const claudeExtraArgs = settings["core.claudeExtraArgs"] || "";

  const id = crypto.randomUUID();
  const content = generateTaskContent(title, columnId, undefined, id);
  const filename = generatePendingFilename();
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  await app.vault.create(filePath, content);
  console.log(`[work-terminal] Task created: ${filePath}`);

  // Background enrichment - returns a promise the caller can track
  const fullPath = resolveFullPath(app, filePath);
  const enrichPrompt =
    `/tc-tasks:task-agent --fast The task file at ${fullPath} was just created with minimal data. ` +
    `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place. ` +
    RENAME_INSTRUCTION;

  const home = process.env.HOME || "/";
  const enrichmentDone = spawnHeadlessClaude(
    enrichPrompt,
    home,
    claudeCommand,
    claudeExtraArgs,
  ).then(
    (result) => {
      if (result.exitCode === 0) {
        console.log(`[work-terminal] Background enrich completed: ${filePath}`);
      } else {
        console.error(
          `[work-terminal] Background enrich failed (exit ${result.exitCode}):`,
          result.stderr.slice(0, 500),
        );
      }
    },
    (err) => {
      console.error("[work-terminal] Background enrich error:", err);
    },
  );

  return { id, columnId, enrichmentDone };
}

export async function handleSplitTaskCreated(
  app: App,
  title: string,
  columnId: KanbanColumn,
  basePath: string,
  splitFrom: SplitSource,
): Promise<{ path: string; id: string }> {
  const id = crypto.randomUUID();
  const content = generateTaskContent(title, columnId, splitFrom, id);
  const filename = generatePendingFilename();
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  await app.vault.create(filePath, content);
  console.log(`[work-terminal] Split task created: ${filePath} (from ${splitFrom.filename})`);

  return { path: filePath, id };
}

export { RENAME_INSTRUCTION, resolveFullPath };
