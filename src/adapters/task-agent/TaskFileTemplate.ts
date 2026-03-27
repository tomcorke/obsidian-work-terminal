import { slugify } from "../../core/utils";
import type { KanbanColumn } from "./types";

export function generateTaskContent(
  title: string,
  state: KanbanColumn
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = formatActivityDate(new Date());

  // Quote the title to handle special characters in YAML
  const safeTitle = `"${title.replace(/"/g, '\\"')}"`;

  return `---
id: ${id}
tags:
  - task
  - task/${state}

state: ${state}

title: ${safeTitle}

source:
  type: prompt
  id: ""
  url: ""
  captured: ${now}

priority:
  score: 0
  deadline: ""
  impact: medium
  has-blocker: false
  blocker-context: ""

agent-actionable: false

goal: []

related: []

created: ${now}
updated: ${now}
---
# ${title}

## Activity Log
- **${dateStr}** - Task created
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

function formatActivityDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}
