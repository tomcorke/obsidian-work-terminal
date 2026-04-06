import type { WorkItem } from "../core/interfaces";

export function getAgentContextTemplate(settings: Record<string, unknown>): string | null {
  const template = settings["core.additionalAgentContext"];
  if (typeof template !== "string" || template.trim() === "") {
    return null;
  }

  return template;
}

export const getClaudeContextTemplate = getAgentContextTemplate;

export function buildAgentContextPrompt(
  item: WorkItem,
  settings: Record<string, unknown>,
  fullPath?: string,
): string | null {
  const template = getAgentContextTemplate(settings);
  if (!template) {
    return null;
  }

  return template
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, fullPath ?? item.path)
    .replace(/\$id/g, item.id);
}

export const buildClaudeContextPrompt = buildAgentContextPrompt;

/**
 * Expand placeholder variables in a profile template string.
 *
 * Supported placeholders:
 * - $title       - Work item title
 * - $state       - Work item state (e.g. "priority", "active")
 * - $filePath    - Work item file path
 * - $id          - Work item UUID
 * - $sessionId   - Agent session ID (may be a literal "$sessionId" when deferred)
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
): string {
  return template
    .replace(/\$workTerminalPrompt/g, contextPrompt ?? "")
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, item.path)
    .replace(/\$id/g, item.id)
    .replace(/\$sessionId/g, sessionId);
}
