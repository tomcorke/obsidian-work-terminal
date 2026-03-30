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
