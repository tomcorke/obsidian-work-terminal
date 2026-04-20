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
 * Resolve the value for `$absoluteFilePath`. When a fully resolved absolute
 * path is provided, use it. Otherwise warn and fall back to the vault-relative
 * `item.path` so the placeholder still expands to something rather than the
 * literal `$absoluteFilePath`.
 */
function resolveAbsoluteFilePath(item: WorkItem, absolutePath?: string): string {
  if (absolutePath) {
    return absolutePath;
  }
  console.warn(
    `[work-terminal] $absoluteFilePath requested but no absolute path available for item "${item.id}"; falling back to vault-relative path "${item.path}".`,
  );
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
