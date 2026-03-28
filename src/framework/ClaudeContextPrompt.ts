import type { WorkItem } from "../core/interfaces";

export function buildClaudeContextPrompt(
  item: WorkItem,
  settings: Record<string, unknown>,
): string | null {
  const template = settings["core.additionalAgentContext"];
  if (typeof template !== "string" || template === "") {
    return null;
  }

  return template
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, item.path)
    .replace(/\$id/g, item.id);
}
