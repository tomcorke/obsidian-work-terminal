import { slugify, yamlQuoteValue } from "../../core/utils";
import type { KanbanColumn, TaskParent, TaskPriority, TaskSource } from "./types";

export interface SplitSource {
  filename: string;
  title: string;
}

export interface TaskContentOptions {
  parent?: TaskParent;
  tags?: string[];
  source?: Partial<TaskSource>;
  priority?: Partial<TaskPriority>;
  goal?: string[];
}

/** Enrichment metadata to embed in the task file frontmatter. */
export interface EnrichmentMeta {
  profile?: string;
  command: string;
  args: string;
  prompt: string;
  cwd: string;
}

export function generateTaskContent(
  title: string,
  state: KanbanColumn,
  splitFrom?: SplitSource,
  existingId?: string,
  enrichment?: EnrichmentMeta,
  options: TaskContentOptions = {},
): string {
  const id = existingId || crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = formatActivityDate(new Date());

  // Quote the title to handle special characters in YAML
  const safeTitle = `"${title.replace(/"/g, '\\"')}"`;

  const parentLink =
    options.parent?.link || (splitFrom ? `[[${splitFrom.filename.replace(/\.md$/, "")}]]` : "");
  const relatedField = parentLink ? `related:\n  - ${yamlQuoteValue(parentLink)}` : "related: []";
  const activitySuffix = options.parent
    ? ` (sub-task of ${options.parent.link || options.parent.title})`
    : splitFrom
      ? ` (split from [[${splitFrom.filename.replace(/\.md$/, "")}]])`
      : "";

  // Quote a YAML string value, escaping embedded quotes
  const yamlQuote = (s: string): string =>
    `"${s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/"/g, '\\"')}"`;

  const safeState = yamlQuoteValue(state);
  const taskTags =
    options.tags && options.tags.length > 0 ? options.tags : ["task", `task/${state}`];
  const tagsSection = taskTags.map((tag) => `  - ${yamlQuoteValue(tag)}`).join("\n");
  const parentSection = options.parent
    ? `sub-task: true\n` +
      `parent:\n` +
      `  id: ${yamlQuoteValue(options.parent.id)}\n` +
      `  title: ${yamlQuoteValue(options.parent.title)}\n` +
      `  path: ${yamlQuoteValue(options.parent.path)}\n` +
      `  link: ${yamlQuoteValue(options.parent.link)}\n`
    : "";

  const source = {
    type: options.source?.type || "prompt",
    id: options.source?.id ?? (splitFrom ? `split-${now.replace(/[:.]/g, "")}` : ""),
    url: options.source?.url ?? "",
    captured: options.source?.captured ?? now,
  };
  const priority = {
    score: options.priority?.score ?? 0,
    deadline: options.priority?.deadline ?? "",
    impact: options.priority?.impact ?? "medium",
    "has-blocker": options.priority?.["has-blocker"] ?? false,
    "blocker-context": options.priority?.["blocker-context"] ?? "",
  };
  const goal = options.goal ?? [];
  const goalSection =
    goal.length > 0 ? `\n${goal.map((entry) => `  - ${yamlQuoteValue(entry)}`).join("\n")}` : " []";

  const enrichmentSection = enrichment
    ? `enrichment:\n` +
      `  profile: ${yamlQuote(enrichment.profile ?? "")}\n` +
      `  command: ${yamlQuote(enrichment.command)}\n` +
      `  args: ${yamlQuote(enrichment.args)}\n` +
      `  prompt: ${yamlQuote(enrichment.prompt)}\n` +
      `  cwd: ${yamlQuote(enrichment.cwd)}\n`
    : "";

  return `---
id: ${id}
tags:
${tagsSection}
state: ${safeState}
title: ${safeTitle}
source:
  type: ${yamlQuoteValue(source.type)}
  id: ${yamlQuoteValue(source.id)}
  url: ${yamlQuoteValue(source.url)}
  captured: ${yamlQuoteValue(source.captured)}
priority:
  score: ${priority.score}
  deadline: ${yamlQuoteValue(priority.deadline)}
  impact: ${yamlQuoteValue(priority.impact)}
  has-blocker: ${priority["has-blocker"]}
  blocker-context: ${yamlQuoteValue(priority["blocker-context"])}
agent-actionable: false
goal:${goalSection}
${relatedField}
${parentSection}${enrichmentSection ? enrichmentSection + (enrichmentSection.endsWith("\n") ? "" : "\n") : ""}created: ${now}
updated: ${now}
---
# ${title}

## Activity Log
- **${dateStr}** - Task created${activitySuffix}
`;
}

export function generateTaskFilename(title: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const slug = slugify(title);
  return `TASK-${y}${m}${d}-${h}${min}-${slug}.md`;
}

export function generatePendingFilename(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const uuid = crypto.randomUUID().slice(0, 8);
  return `TASK-${y}${m}${d}-${h}${min}-pending-${uuid}.md`;
}

function formatActivityDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}
