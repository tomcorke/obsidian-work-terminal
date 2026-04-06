import { Notice, type App, type TFile } from "obsidian";
import { spawnHeadlessClaude } from "../../core/claude/HeadlessClaude";
import { generateTaskContent, generatePendingFilename } from "./TaskFileTemplate";
import type { SplitSource } from "./TaskFileTemplate";
import { expandTilde } from "../../core/utils";
import { STATE_FOLDER_MAP, type KanbanColumn } from "./types";

/**
 * Find a vault file by its frontmatter UUID. Scans all markdown files under
 * the task base path. Returns null if no file with a matching `id` field is found.
 */
function findFileByUuid(app: App, uuid: string, basePath: string): TFile | null {
  const normalizedBase = basePath.endsWith("/") ? basePath : basePath + "/";
  const allFiles = app.vault.getMarkdownFiles();
  for (const file of allFiles) {
    if (!file.path.startsWith(normalizedBase)) continue;
    const cache = app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.id === uuid) {
      return file;
    }
  }
  return null;
}

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

function resolveClaudeLaunchCwd(settings: Record<string, any>): string {
  return expandTilde(settings["core.defaultTerminalCwd"] || "~");
}

/**
 * Detect known patterns in Claude stdout that indicate silent failure despite exit code 0.
 * Returns a short description of the failure, or null if none detected.
 */
function detectSilentFailure(stdout: string): string | null {
  const match = stdout.match(/Unknown skill:\s*\S+/i);
  return match ? match[0] : null;
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
    `The task file at ${fullPath} was just created with minimal data. ` +
    `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place. ` +
    RENAME_INSTRUCTION;

  const enrichmentDone = spawnHeadlessClaude(
    enrichPrompt,
    resolveClaudeLaunchCwd(settings),
    claudeCommand,
    claudeExtraArgs,
  ).then(
    async (result) => {
      // Resolve current file location: original path may have changed if
      // the task was moved (e.g. via drag-drop) while enrichment was running.
      const currentFile = resolveFileByPathOrUuid(app, filePath, id, basePath);
      const currentPath = currentFile?.path ?? filePath;

      if (result.missingCli) {
        new Notice(result.stderr);
        console.warn("[work-terminal] Background enrich skipped:", result.stderr);
        await markIngestionFailed(app, currentPath);
        return;
      }
      if (result.timedOut) {
        console.error(`[work-terminal] Background enrich timed out: ${currentPath}`, result.stderr);
        new Notice("Background enrichment timed out. Right-click the card to retry.", 8000);
        await markIngestionFailed(app, currentPath);
        return;
      }
      if (result.exitCode === 0) {
        const silentFailure = detectSilentFailure(result.stdout);
        if (silentFailure) {
          console.error(
            `[work-terminal] Background enrich exited 0 but reported: ${silentFailure}`,
          );
          await markIngestionFailed(app, currentPath);
          return;
        }

        // If the file was moved during enrichment, the headless Claude
        // process was working on a stale path. Mark as failed so the user
        // can retry from the correct location.
        // However, Claude itself renames the pending file as part of
        // successful enrichment (removing the "-pending-" segment). Only
        // treat it as a user-initiated move if the UUID-resolved file is
        // still pending-style OR is in a different folder.
        if (currentPath !== filePath) {
          const originalFolder = filePath.substring(0, filePath.lastIndexOf("/"));
          const currentFolder = currentPath.substring(0, currentPath.lastIndexOf("/"));
          const currentFilename = currentPath.substring(currentPath.lastIndexOf("/") + 1);
          const isPendingFilename = /pending-[0-9a-f]+/i.test(currentFilename);

          if (currentFolder !== originalFolder || isPendingFilename) {
            console.warn(
              `[work-terminal] Task moved during enrichment: ${filePath} -> ${currentPath}. Marking for retry.`,
            );
            new Notice("Task was moved during enrichment. Right-click the card to retry.", 8000);
            await markIngestionFailed(app, currentPath);
            return;
          }
          // Same folder, no longer pending - normal enrichment rename. Let
          // the success path proceed.
        }

        // Success requires an observable outcome: the pending file must have been
        // renamed away. If it still exists the enrichment was a no-op.
        const pendingStillExists = await app.vault.adapter.exists(filePath);
        if (pendingStillExists) {
          console.warn(
            `[work-terminal] Background enrich exited 0 but pending file was not renamed: ${filePath}`,
          );
          await markIngestionFailed(app, filePath);
          return;
        }
        console.log(`[work-terminal] Background enrich completed: ${filePath}`);
      } else {
        console.error(
          `[work-terminal] Background enrich failed (exit ${result.exitCode}):`,
          result.stderr.slice(0, 500),
        );
        new Notice("Background enrichment failed. Right-click the card to retry.", 8000);
        await markIngestionFailed(app, currentPath);
      }
    },
    async (err) => {
      console.error("[work-terminal] Background enrich error:", err);
      const currentFile = resolveFileByPathOrUuid(app, filePath, id, basePath);
      await markIngestionFailed(app, currentFile?.path ?? filePath);
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

const INGESTION_FAILED_NOTE =
  `> [!warning] Background ingestion incomplete\n` +
  `> Automatic enrichment was attempted but did not complete successfully.\n` +
  `> To enrich this task, right-click the card and select **Retry Enrichment**,\n` +
  `> or open a Claude session and use the task-agent skill manually.\n`;

/**
 * Mark a task file as having failed background ingestion.
 * Adds `background-ingestion: failed` to frontmatter and appends a note to the body.
 */
async function markIngestionFailed(app: App, filePath: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!file) {
    console.warn(`[work-terminal] Cannot mark ingestion failed - file not found: ${filePath}`);
    return;
  }

  try {
    const content = await app.vault.read(file);
    const updated = insertIngestionFailedFlag(content);
    await app.vault.modify(file, updated);
    console.log(`[work-terminal] Marked ingestion failed: ${filePath}`);
  } catch (err) {
    console.error(`[work-terminal] Failed to mark ingestion failure on ${filePath}:`, err);
  }
}

/**
 * Insert `background-ingestion: failed` into frontmatter and append a callout note.
 * Exported for testing.
 */
export function insertIngestionFailedFlag(content: string): string {
  // Only treat a leading `---` block as YAML frontmatter; ignore `---` later in the file.
  if (!content.startsWith("---")) return content;

  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(---(?:\r?\n|$))/);
  if (!fmMatch) return content;

  const [fullMatch, openFence, frontmatter, closeFence] = fmMatch;
  const newline = openFence.endsWith("\r\n") ? "\r\n" : "\n";

  // Replace existing flag or insert before closing fence
  let updatedFm: string;
  if (/^background-ingestion:[ \t]*/m.test(frontmatter)) {
    updatedFm = frontmatter.replace(
      /^background-ingestion:[ \t]*[^\r\n]*/m,
      "background-ingestion: failed",
    );
  } else {
    updatedFm = `${frontmatter}background-ingestion: failed${newline}`;
  }

  let result = content.replace(fullMatch, `${openFence}${updatedFm}${closeFence}`);

  // Append the callout note if not already present
  if (!result.includes("Background ingestion incomplete")) {
    result = result.trimEnd() + `\n\n${INGESTION_FAILED_NOTE}`;
  }

  return result;
}

/**
 * Clear the `background-ingestion: failed` flag from a task file by setting it to `retrying`.
 * Called before retrying enrichment.
 */
async function clearIngestionFailedFlag(app: App, filePath: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!file) return;

  try {
    let content = await app.vault.read(file);
    content = content.replace(
      /^background-ingestion:[ \t]*failed[^\r\n]*/m,
      "background-ingestion: retrying",
    );
    await app.vault.modify(file, content);
  } catch (err) {
    console.error(`[work-terminal] Failed to clear ingestion flag on ${filePath}:`, err);
  }
}

/**
 * Prepare a retry enrichment: fully remove the background-ingestion flag and
 * warning callout, then return the enrichment prompt for use in a foreground
 * Claude session.
 */
export async function prepareRetryEnrichment(app: App, filePath: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (file) {
    try {
      let content = await app.vault.read(file);
      content = content.replace(/^background-ingestion:[ \t]*[^\r\n]*\r?\n?/m, "");
      content = content.replace(
        /> \[!warning\] Background ingestion incomplete[\s\S]*?(?=\n[^>]|\n*$)/g,
        "",
      );
      content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      await app.vault.modify(file, content);
    } catch (err) {
      console.error(`[work-terminal] Failed to clear ingestion markers on ${filePath}:`, err);
    }
  }

  const fullPath = resolveFullPath(app, filePath);
  return (
    `The task file at ${fullPath} needs enrichment. ` +
    `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place. ` +
    RENAME_INSTRUCTION
  );
}

/**
 * Resolve a task file by its original path first, falling back to UUID-based
 * lookup if the file has been moved. Returns null only if the file cannot be
 * found by either method.
 */
function resolveFileByPathOrUuid(
  app: App,
  originalPath: string,
  uuid: string,
  basePath: string,
): TFile | null {
  const byPath = app.vault.getAbstractFileByPath(originalPath) as TFile | null;
  if (byPath) return byPath;
  return findFileByUuid(app, uuid, basePath);
}

export { RENAME_INSTRUCTION, resolveFullPath, findFileByUuid };
