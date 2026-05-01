import { Notice, type App, type TFile } from "obsidian";
import {
  spawnHeadlessClaude,
  spawnHeadlessAgent,
  DEFAULT_TIMEOUT_MS,
} from "../../core/claude/HeadlessClaude";
import { generateTaskContent, generatePendingFilename } from "./TaskFileTemplate";
import type { SplitSource, EnrichmentMeta } from "./TaskFileTemplate";
import { expandTilde } from "../../core/utils";
import type { ItemCreationResult } from "../../core/interfaces";
import {
  STATE_FOLDER_MAP,
  type KanbanColumn,
  type TaskFile,
  type TaskParent,
  type TaskPriority,
  type TaskSource,
} from "./types";
import { writeEnrichmentLog, type EnrichmentLogParams } from "./EnrichmentLogger";

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

const PRESERVE_ENRICHMENT_BLOCK = `Preserve the \`enrichment:\` block in the YAML frontmatter exactly as-is - do not remove, modify, or reformat it.`;

/**
 * Default enrichment prompt template. `$filePath` is replaced with the
 * vault-relative path, `$absoluteFilePath` with the absolute filesystem path
 * (which is what the agent needs in order to `cd` into the folder and read
 * the file contents directly).
 */
export const DEFAULT_ENRICHMENT_PROMPT =
  `The task file at $absoluteFilePath was just created with minimal data. ` +
  `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place. ` +
  PRESERVE_ENRICHMENT_BLOCK +
  " " +
  RENAME_INSTRUCTION;

/** Default retry enrichment prompt template. */
export const DEFAULT_RETRY_ENRICHMENT_PROMPT =
  `The task file at $absoluteFilePath needs enrichment. ` +
  `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place. ` +
  PRESERVE_ENRICHMENT_BLOCK +
  " " +
  RENAME_INSTRUCTION;

/**
 * Resolve an enrichment prompt template, substituting `$filePath` with the
 * vault-relative path and `$absoluteFilePath` with the fully resolved absolute
 * filesystem path. A negative lookahead on `[A-Za-z0-9_]` prevents the
 * replacement from matching placeholder prefixes embedded in longer
 * identifiers (e.g. `$filePathBasename` stays untouched), so only the exact
 * placeholders are substituted. `$absoluteFilePath` is replaced first because
 * the two placeholders share a prefix; substituting `$filePath` first would
 * still respect the lookahead (the next character is `A`), but replacing the
 * longer form first keeps the intent obvious to future readers.
 */
function resolveEnrichmentPrompt(
  template: string,
  vaultRelativePath: string,
  absolutePath: string,
): string {
  return template
    .replace(/\$absoluteFilePath(?![A-Za-z0-9_])/g, absolutePath)
    .replace(/\$filePath(?![A-Za-z0-9_])/g, vaultRelativePath);
}

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
 * Resolve the enrichment timeout from settings. The setting is stored as a
 * string representing seconds. Returns the timeout in milliseconds, falling
 * back to DEFAULT_TIMEOUT_MS if the value is empty or invalid.
 */
export function resolveEnrichmentTimeout(settings: Record<string, any>): number {
  const raw = settings["adapter.enrichmentTimeout"];
  if (raw == null || raw === "") return DEFAULT_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.round(seconds * 1000);
}

/**
 * Detect known patterns in Claude stdout that indicate silent failure despite exit code 0.
 * Returns a short description of the failure, or null if none detected.
 */
function detectSilentFailure(stdout: string): string | null {
  const match = stdout.match(/Unknown skill:\s*\S+/i);
  return match ? match[0] : null;
}

export interface ItemCreatedResult extends ItemCreationResult {
  path: string;
  title: string;
  enrichmentDone: Promise<void>;
}

export type EnrichmentLaunchMode = "background" | "foreground";

export function resolveEnrichmentLaunchMode(settings: Record<string, any>): EnrichmentLaunchMode {
  return settings["adapter.enrichmentMode"] === "foreground" ? "foreground" : "background";
}

/**
 * Resolve whether enrichment-failure logging is enabled. Defaults to `true`
 * so users benefit from the log files even without opting in explicitly.
 */
function isEnrichmentLoggingEnabled(settings: Record<string, any>): boolean {
  return settings["core.enrichmentLogging"] !== false;
}

/**
 * Dispatch an enrichment failure log write. Never throws; callers treat
 * logging as a pure side-effect that must not interfere with the ordinary
 * failure-handling flow (marking the task as failed, notifying the user).
 */
function logEnrichmentFailure(
  app: App,
  settings: Record<string, any>,
  params: EnrichmentLogParams,
): void {
  if (!isEnrichmentLoggingEnabled(settings)) return;
  // Fire-and-forget: writeEnrichmentLog itself swallows adapter errors.
  void writeEnrichmentLog(app, params).catch((err) => {
    console.error("[work-terminal] Unexpected enrichment log failure:", err);
  });
}

/** Resolved enrichment profile data passed by the adapter. */
export interface EnrichmentProfileOverride {
  command: string;
  args: string;
  cwd: string;
  /** Agent name for error messages. */
  agentName?: string;
  /** How to inject the prompt - "claude" (default), "flag", or "positional". */
  promptMode?: "claude" | "flag" | "positional";
  /** Flag name when promptMode is "flag" (e.g. "-i"). */
  promptFlag?: string;
}

export async function handleItemCreated(
  app: App,
  title: string,
  settings: Record<string, any>,
  profileOverride?: EnrichmentProfileOverride,
): Promise<ItemCreatedResult> {
  const columnId = (settings._columnId || "todo") as KanbanColumn;
  const basePath = settings["adapter.taskBasePath"] || "2 - Areas/Tasks";
  const claudeCommand = profileOverride?.command || settings["core.claudeCommand"] || "claude";
  const claudeExtraArgs = profileOverride?.args ?? (settings["core.claudeExtraArgs"] || "");

  const enrichmentEnabled = settings["adapter.enrichmentEnabled"] !== false;
  const enrichmentMode = resolveEnrichmentLaunchMode(settings);

  const id = crypto.randomUUID();
  const filename = generatePendingFilename();
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  // Resolve enrichment parameters before file creation so metadata can be embedded
  let enrichmentMeta: EnrichmentMeta | undefined;
  let enrichPrompt: string | undefined;
  let enrichCwd: string | undefined;
  let timeoutMs: number | undefined;

  if (enrichmentEnabled) {
    const fullPath = resolveFullPath(app, filePath);
    const promptTemplate =
      (settings["adapter.enrichmentPrompt"] as string) || DEFAULT_ENRICHMENT_PROMPT;
    enrichPrompt = resolveEnrichmentPrompt(promptTemplate, filePath, fullPath);
    timeoutMs = resolveEnrichmentTimeout(settings);
    enrichCwd = profileOverride?.cwd
      ? expandTilde(profileOverride.cwd)
      : resolveClaudeLaunchCwd(settings);

    enrichmentMeta = {
      profile: profileOverride?.agentName ?? "",
      command: claudeCommand,
      args: claudeExtraArgs,
      prompt: enrichPrompt,
      cwd: enrichCwd,
    };
  }

  const content = generateTaskContent(title, columnId, undefined, id, enrichmentMeta);

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  await app.vault.create(filePath, content);
  console.log(`[work-terminal] Task created: ${filePath}`);

  // Skip enrichment if explicitly disabled
  if (!enrichmentEnabled) {
    return { id, columnId, path: filePath, title, enrichmentDone: Promise.resolve() };
  }

  if (enrichmentMode === "foreground") {
    return {
      id,
      columnId,
      path: filePath,
      title,
      enrichmentDone: Promise.resolve(),
      foregroundEnrichment: {
        prompt: enrichPrompt!,
        label: "Enrich",
      },
    };
  }

  // Use the generic headless agent when a profile override specifies non-Claude
  // prompt injection, otherwise fall back to the Claude-specific path.
  const spawnPromise =
    profileOverride?.promptMode && profileOverride.promptMode !== "claude"
      ? spawnHeadlessAgent(enrichPrompt!, {
          command: claudeCommand,
          extraArgs: claudeExtraArgs,
          cwd: enrichCwd!,
          promptMode: profileOverride.promptMode,
          promptFlag: profileOverride.promptFlag,
          timeoutMs: timeoutMs!,
          agentName: profileOverride.agentName,
        })
      : spawnHeadlessClaude(enrichPrompt!, enrichCwd!, claudeCommand, claudeExtraArgs, timeoutMs!);

  // Common metadata captured once so every failure branch can attach it to
  // the log entry without recomputing.
  const logBase: Omit<EnrichmentLogParams, "category" | "summary"> = {
    itemId: id,
    filePath,
    originalFilename: filename,
    titleHint: title,
    prompt: enrichPrompt,
    command: claudeCommand,
    args: claudeExtraArgs,
    cwd: enrichCwd,
    agentName: profileOverride?.agentName || "claude",
    timeoutMs,
  };

  const enrichmentDone = spawnPromise.then(
    async (result) => {
      // Resolve current file location: original path may have changed if
      // the task was moved (e.g. via drag-drop) while enrichment was running.
      const currentFile = resolveFileByPathOrUuid(app, filePath, id, basePath);
      const currentPath = currentFile?.path ?? filePath;

      if (result.missingCli) {
        new Notice(result.stderr);
        console.warn("[work-terminal] Background enrich skipped:", result.stderr);
        logEnrichmentFailure(app, settings, {
          ...logBase,
          filePath: currentPath,
          category: "missing-cli",
          summary: "Configured agent CLI could not be resolved",
          stderr: result.stderr,
          stdout: result.stdout,
        });
        await markIngestionFailed(app, currentPath);
        return;
      }
      if (result.timedOut) {
        console.error(`[work-terminal] Background enrich timed out: ${currentPath}`, result.stderr);
        new Notice("Background enrichment timed out. Right-click the card to retry.", 8000);
        logEnrichmentFailure(app, settings, {
          ...logBase,
          filePath: currentPath,
          category: "timeout",
          summary: result.stderr || "Headless agent timed out",
          stderr: result.stderr,
          stdout: result.stdout,
          exitCode: result.exitCode,
        });
        await markIngestionFailed(app, currentPath);
        return;
      }
      if (result.exitCode === 0) {
        const silentFailure = detectSilentFailure(result.stdout);
        if (silentFailure) {
          console.error(
            `[work-terminal] Background enrich exited 0 but reported: ${silentFailure}`,
          );
          logEnrichmentFailure(app, settings, {
            ...logBase,
            filePath: currentPath,
            category: "silent-failure",
            summary: `Exit 0 but stdout reported: ${silentFailure}`,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
            adapterValidation: silentFailure,
          });
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
            logEnrichmentFailure(app, settings, {
              ...logBase,
              filePath: currentPath,
              category: "moved-during-enrichment",
              summary: `Task moved during enrichment: ${filePath} -> ${currentPath}`,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
              adapterValidation: `original=${filePath} current=${currentPath}`,
            });
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
          logEnrichmentFailure(app, settings, {
            ...logBase,
            filePath,
            category: "pending-not-renamed",
            summary: "Exit 0 but pending file was not renamed by the agent",
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
            adapterValidation: "pending file still exists on disk after exit 0",
          });
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
        logEnrichmentFailure(app, settings, {
          ...logBase,
          filePath: currentPath,
          category: "non-zero-exit",
          summary: `Agent exited with code ${result.exitCode}`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
        await markIngestionFailed(app, currentPath);
      }
    },
    async (err) => {
      console.error("[work-terminal] Background enrich error:", err);
      const currentFile = resolveFileByPathOrUuid(app, filePath, id, basePath);
      const resolvedPath = currentFile?.path ?? filePath;
      logEnrichmentFailure(app, settings, {
        ...logBase,
        filePath: resolvedPath,
        category: "spawn-error",
        summary:
          err instanceof Error
            ? `Spawn rejected: ${err.message}`
            : `Spawn rejected: ${String(err)}`,
        error: err,
      });
      await markIngestionFailed(app, resolvedPath);
    },
  );

  return { id, columnId, path: filePath, title, enrichmentDone };
}

export interface SubTaskParentSource {
  id: string;
  title: string;
  path: string;
  filename: string;
  source?: TaskSource;
  priority?: TaskPriority;
  tags?: string[];
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

export async function handleSubTaskCreated(
  app: App,
  parent: SubTaskParentSource,
  focus: string,
  columnId: string,
  basePath: string,
  resolvedFolderName?: string | null,
): Promise<{ path: string; id: string; title: string; task: TaskFile }> {
  const id = crypto.randomUUID();
  const requestedScope = focus.trim();
  const folderPath = resolveSubTaskFolderPath(parent, columnId, basePath, resolvedFolderName);
  const filename = generatePendingFilename();
  const filePath = `${folderPath}/${filename}`;
  const parentTitle = parent.title.trim() || parent.filename.replace(/\.md$/, "");
  const title = `Sub-task from: ${parentTitle}`;
  const parentLinkTitle = parentTitle.replace(/]/g, "");
  const parentReference: TaskParent = {
    id: parent.id,
    title: parentTitle,
    path: parent.path,
    link: `[[${parent.filename.replace(/\.md$/, "")}|${parentLinkTitle}]]`,
  };

  const inheritedTags = Array.from(
    new Set([
      "task",
      `task/${columnId}`,
      "sub-task",
      ...(parent.tags || []).filter(
        (tag) => tag !== "task" && !tag.startsWith("task/") && tag !== "sub-task",
      ),
    ]),
  );

  const inheritedPriority: Partial<TaskPriority> = parent.priority
    ? {
        deadline: parent.priority.deadline,
        impact: parent.priority.impact,
        "has-blocker": parent.priority["has-blocker"],
        "blocker-context": parent.priority["blocker-context"],
      }
    : {};

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const task: TaskFile = {
    id,
    path: filePath,
    filename,
    state: columnId,
    title,
    tags: inheritedTags,
    source: parent.source ?? {
      type: "prompt",
      id: "",
      url: "",
      captured: "",
    },
    priority: {
      score: 0,
      deadline: inheritedPriority.deadline ?? "",
      impact: inheritedPriority.impact ?? "medium",
      "has-blocker": inheritedPriority["has-blocker"] ?? false,
      "blocker-context": inheritedPriority["blocker-context"] ?? "",
    },
    agentActionable: false,
    goal: [],
    parent: parentReference,
    isSubTask: true,
    created: now,
    updated: now,
    lastActive: "",
  };

  const content = generateTaskContent(title, columnId, undefined, id, undefined, {
    parent: parentReference,
    tags: inheritedTags,
    source: parent.source,
    priority: inheritedPriority,
    activityLogEntries: [`Requested scope: ${requestedScope}`],
  });

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  await app.vault.create(filePath, content);
  console.log(`[work-terminal] Sub-task created: ${filePath} (parent ${parent.path})`);

  return { path: filePath, id, title, task };
}

function resolveSubTaskFolderPath(
  parent: SubTaskParentSource,
  columnId: string,
  basePath: string,
  resolvedFolderName?: string | null,
): string {
  const folderName = resolvedFolderName || STATE_FOLDER_MAP[columnId as KanbanColumn];
  if (folderName) {
    return `${basePath}/${folderName}`;
  }

  const parentFolder = parent.path.includes("/")
    ? parent.path.substring(0, parent.path.lastIndexOf("/"))
    : "";
  return parentFolder || basePath;
}

const INGESTION_FAILED_NOTE =
  `> [!warning] Background ingestion incomplete\n` +
  `> Automatic enrichment was attempted but did not complete successfully.\n` +
  `> To enrich this task, right-click the card and select **Retry Enrichment**,\n` +
  `> or open an agent session and enrich the task manually.\n`;

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
 * Prepare a retry enrichment: fully remove the background-ingestion flag and
 * warning callout, then return the enrichment prompt for use in a foreground
 * Claude session.
 */
export async function prepareRetryEnrichment(
  app: App,
  filePath: string,
  retryPromptTemplate?: string,
): Promise<string> {
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
  const template = retryPromptTemplate || DEFAULT_RETRY_ENRICHMENT_PROMPT;
  return resolveEnrichmentPrompt(template, filePath, fullPath);
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
