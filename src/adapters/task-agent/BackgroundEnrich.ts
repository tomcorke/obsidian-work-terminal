import type { App } from "obsidian";
import { spawnHeadlessClaude } from "../../core/claude/HeadlessClaude";
import { generateTaskContent, generateTaskFilename } from "./TaskFileTemplate";
import type { SplitSource } from "./TaskFileTemplate";
import { STATE_FOLDER_MAP, type KanbanColumn } from "./types";

export async function handleItemCreated(
  app: App,
  title: string,
  settings: Record<string, any>
): Promise<void> {
  const columnId = (settings._columnId || "todo") as KanbanColumn;
  const basePath = settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
  const claudeCommand = settings["core.claudeCommand"] || "claude";

  // Generate file content and filename
  const content = generateTaskContent(title, columnId);
  const filename = generateTaskFilename(title);
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  // Ensure target folder exists
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  // Create the task file
  await app.vault.create(filePath, content);
  console.log(`[work-terminal] Task created: ${filePath}`);

  // Spawn background enrichment (fire and don't let failures propagate)
  try {
    const enrichPrompt =
      `/tc-tasks:task-agent --fast The task file at ${filePath} was just created with minimal data. ` +
      `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place.`;

    const home = process.env.HOME || "/";
    const result = await spawnHeadlessClaude(enrichPrompt, home, claudeCommand);

    if (result.exitCode === 0) {
      console.log(`[work-terminal] Background enrich completed: ${filePath}`);
    } else {
      console.error(
        `[work-terminal] Background enrich failed (exit ${result.exitCode}):`,
        result.stderr.slice(0, 500)
      );
    }
  } catch (err) {
    console.error("[work-terminal] Background enrich error:", err);
  }
}

export async function handleSplitTaskCreated(
  app: App,
  title: string,
  columnId: KanbanColumn,
  basePath: string,
  splitFrom: SplitSource
): Promise<string> {
  const content = generateTaskContent(title, columnId, splitFrom);
  const filename = generateTaskFilename(title);
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  await app.vault.create(filePath, content);
  console.log(`[work-terminal] Split task created: ${filePath} (from ${splitFrom.filename})`);

  return filePath;
}
