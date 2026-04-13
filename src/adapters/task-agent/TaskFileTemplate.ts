import { slugify } from "../../core/utils";
import type { KanbanColumn } from "./types";

export interface SplitSource {
  filename: string;
  title: string;
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
): string {
  const id = existingId || crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = formatActivityDate(new Date());

  // Quote the title to handle special characters in YAML
  const safeTitle = `"${title.replace(/"/g, '\\"')}"`;

  const relatedField = splitFrom
    ? `related:\n  - "[[${splitFrom.filename.replace(/\.md$/, "")}]]"`
    : "related: []";
  const activitySuffix = splitFrom
    ? ` (split from [[${splitFrom.filename.replace(/\.md$/, "")}]])`
    : "";

  // Quote a YAML string value, escaping embedded quotes
  const yamlQuote = (s: string): string =>
    `"${s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/"/g, '\\"')}"`;

  const enrichmentBlock = enrichment
    ? `\nenrichment:\n` +
      `  profile: ${yamlQuote(enrichment.profile ?? "")}\n` +
      `  command: ${yamlQuote(enrichment.command)}\n` +
      `  args: ${yamlQuote(enrichment.args)}\n` +
      `  prompt: ${yamlQuote(enrichment.prompt)}\n` +
      `  cwd: ${yamlQuote(enrichment.cwd)}\n`
    : "";

  return `---
id: ${id}
tags:
  - task
  - task/${state}

state: ${state}

title: ${safeTitle}

source.type: prompt
source.id: "${splitFrom ? `split-${now.replace(/[:.]/g, "")}` : ""}"
source.url: ""
source.captured: ${now}

priority.score: 0
priority.deadline: ""
priority.impact: medium
priority.has-blocker: false
priority.blocker-context: ""

agent-actionable: false

goal: []

${relatedField}
${enrichmentBlock}
created: ${now}
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
