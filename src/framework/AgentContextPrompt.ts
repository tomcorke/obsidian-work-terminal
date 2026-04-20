import type { WorkItem } from "../core/interfaces";

export function getAgentContextTemplate(settings: Record<string, unknown>): string | null {
  const template = settings["core.additionalAgentContext"];
  if (typeof template !== "string" || template.trim() === "") {
    return null;
  }

  return template;
}

export const getClaudeContextTemplate = getAgentContextTemplate;

/**
 * Check whether a path is actually absolute in any common form we might
 * encounter at runtime. We intentionally accept POSIX, Windows drive letter,
 * and UNC style paths regardless of the current platform - the Obsidian
 * renderer might be asked to format paths from a different OS convention,
 * and it's cheap to be permissive here.
 */
function isAbsolutePath(candidate: string): boolean {
  // POSIX absolute ("/foo") and POSIX-style UNC ("//server/share").
  if (candidate.startsWith("/")) {
    return true;
  }
  // Windows UNC ("\\\\server\\share") and Windows root ("\\foo").
  if (candidate.startsWith("\\")) {
    return true;
  }
  // Windows drive letter ("C:/foo" or "C:\\foo").
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) {
    return true;
  }
  return false;
}

/**
 * Resolve the value for `$absoluteFilePath`. When a fully resolved absolute
 * path is provided, use it. Otherwise warn and fall back to the vault-relative
 * `item.path` so the placeholder still expands to something rather than the
 * literal `$absoluteFilePath`.
 *
 * Callers occasionally can't resolve the vault base path (e.g.
 * `TerminalPanelView.resolveWorkItemPath` returns `itemPath` unchanged when
 * `vaultPath` is empty), which would hand us a vault-relative string even
 * though the parameter is typed as the absolute path. Validate the shape of
 * the input and treat non-absolute values the same as if nothing was
 * provided - warn and fall back to `item.path`.
 */
function resolveAbsoluteFilePath(item: WorkItem, absolutePath?: string): string {
  if (absolutePath && isAbsolutePath(absolutePath)) {
    return absolutePath;
  }
  if (absolutePath) {
    console.warn(
      `[work-terminal] $absoluteFilePath requested but the supplied path "${absolutePath}" is not absolute for item "${item.id}"; falling back to vault-relative path "${item.path}".`,
    );
  } else {
    console.warn(
      `[work-terminal] $absoluteFilePath requested but no absolute path available for item "${item.id}"; falling back to vault-relative path "${item.path}".`,
    );
  }
  return item.path;
}

/**
 * Build the additional agent context prompt from the user-configured template.
 *
 * Supported placeholders:
 * - $title             - Work item title
 * - $state             - Work item state (e.g. "priority", "active")
 * - $filePath          - Work item file path (vault-relative)
 * - $absoluteFilePath  - Fully resolved absolute filesystem path to the work item file.
 *                        Falls back to the vault-relative `item.path` (with a console warning)
 *                        when no `fullPath` is supplied.
 * - $id                - Work item UUID
 */
export function buildAgentContextPrompt(
  item: WorkItem,
  settings: Record<string, unknown>,
  fullPath?: string,
): string | null {
  const template = getAgentContextTemplate(settings);
  if (!template) {
    return null;
  }

  const needsAbsolute = /\$absoluteFilePath/.test(template);
  const absolute = needsAbsolute ? resolveAbsoluteFilePath(item, fullPath) : item.path;

  return template
    .replace(/\$absoluteFilePath/g, absolute)
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, item.path)
    .replace(/\$id/g, item.id);
}

export const buildClaudeContextPrompt = buildAgentContextPrompt;

/**
 * Expand placeholder variables in a profile template string.
 *
 * Supported placeholders:
 * - $title             - Work item title
 * - $state             - Work item state (e.g. "priority", "active")
 * - $filePath          - Work item file path (vault-relative)
 * - $absoluteFilePath  - Fully resolved absolute filesystem path to the work item file.
 *                        Falls back to the vault-relative `item.path` (with a console warning)
 *                        when no `absoluteFilePath` is supplied.
 * - $id                - Work item UUID
 * - $sessionId         - Agent session ID (may be a literal "$sessionId" when deferred)
 * - $workTerminalPrompt - The fully assembled context prompt string, when provided via
 *                         the optional `contextPrompt` argument; otherwise expands to ""
 *
 * Used for both the "extra args" and "context prompt" fields on agent profiles.
 * `$workTerminalPrompt` is only meaningful when expanding extra args with an already
 * assembled context prompt passed in as `contextPrompt`.
 */
export function expandProfilePlaceholders(
  template: string,
  item: WorkItem,
  sessionId: string,
  contextPrompt?: string,
  absoluteFilePath?: string,
): string {
  const needsAbsolute = /\$absoluteFilePath/.test(template);
  const absolute = needsAbsolute ? resolveAbsoluteFilePath(item, absoluteFilePath) : item.path;

  return template
    .replace(/\$workTerminalPrompt/g, contextPrompt ?? "")
    .replace(/\$absoluteFilePath/g, absolute)
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, item.path)
    .replace(/\$id/g, item.id)
    .replace(/\$sessionId/g, sessionId);
}
