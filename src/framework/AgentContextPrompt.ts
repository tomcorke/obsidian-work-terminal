import type { WorkItem } from "../core/interfaces";

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

function getParentMetadata(item: WorkItem): Record<string, string> | null {
  const parent = (item.metadata as Record<string, any> | undefined)?.parent;
  if (!parent || typeof parent !== "object") return null;
  return {
    id: typeof parent.id === "string" ? parent.id : "",
    title: typeof parent.title === "string" ? parent.title : "",
    path: typeof parent.path === "string" ? parent.path : "",
  };
}

function resolveParentAbsoluteFilePath(
  item: WorkItem,
  parentPath: string,
  absolutePath?: string,
): string {
  if (!parentPath) return "";
  if (!absolutePath || !isAbsolutePath(absolutePath)) return parentPath;

  const normalizedAbsolute = absolutePath.replace(/\\/g, "/");
  const normalizedItemPath = item.path.replace(/\\/g, "/");
  if (!normalizedAbsolute.endsWith(normalizedItemPath)) return parentPath;

  const base = absolutePath.slice(0, absolutePath.length - item.path.length).replace(/[\\/]$/, "");
  const separator = absolutePath.includes("\\") ? "\\" : "/";
  return `${base}${separator}${parentPath.replace(/[\\/]/g, separator)}`;
}

/**
 * Expand placeholder variables in a profile template string.
 *
 * Supported placeholders:
 * - $title             - Work item title
 * - $state             - Work item state (e.g. "priority", "active")
 * - $filePath          - Work item file path (vault-relative)
 * - $parentTitle       - Parent task title for sub-tasks, otherwise ""
 * - $parentId          - Parent task UUID for sub-tasks, otherwise ""
 * - $parentFilePath    - Parent task file path (vault-relative) for sub-tasks, otherwise ""
 * - $parentAbsoluteFilePath - Fully resolved absolute filesystem path to the parent task file
 *                        when available, otherwise the vault-relative parent path or ""
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
  const parent = getParentMetadata(item);
  const parentPath = parent?.path ?? "";
  const parentAbsolute = /\$parentAbsoluteFilePath/.test(template)
    ? resolveParentAbsoluteFilePath(item, parentPath, absoluteFilePath)
    : parentPath;

  return template
    .replace(/\$workTerminalPrompt/g, contextPrompt ?? "")
    .replace(/\$parentAbsoluteFilePath/g, parentAbsolute)
    .replace(/\$absoluteFilePath/g, absolute)
    .replace(/\$parentFilePath/g, parentPath)
    .replace(/\$parentTitle/g, parent?.title ?? "")
    .replace(/\$parentId/g, parent?.id ?? "")
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, item.path)
    .replace(/\$id/g, item.id)
    .replace(/\$sessionId/g, sessionId);
}
