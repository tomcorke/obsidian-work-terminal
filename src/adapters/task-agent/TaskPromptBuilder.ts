import type { WorkItem, WorkItemPromptBuilder } from "../../core/interfaces";

export class TaskPromptBuilder implements WorkItemPromptBuilder {
  buildPrompt(item: WorkItem, fullPath: string): string {
    const meta = (item.metadata || {}) as Record<string, any>;
    const priority = meta.priority || {};

    let prompt = `Task: ${item.title}\nState: ${item.state}\nFile: ${fullPath}`;

    if (priority.deadline) {
      prompt += `\nDeadline: ${priority.deadline}`;
    }

    if (priority["has-blocker"] && priority["blocker-context"]) {
      prompt += `\nBlocker: ${priority["blocker-context"]}`;
    }

    return prompt;
  }

  describePromptFormat(): string {
    // This string is a non-editable descriptor shown in the profile UI, not a
    // user-editable template. It is cosmetic only; `buildPrompt` is the
    // single source of truth for the actual adapter prompt contents.
    return "Task: $title\nState: $state\nFile: $filePath\nDeadline: $deadline (if set)\nBlocker: $blocker (if set)";
  }
}
