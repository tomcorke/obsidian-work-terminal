# Template-based context prompt for Claude (ctx)

## Goal
Replace the hardcoded context prompt with a user-configurable template in settings. Hide the "+ Claude (ctx)" button when no template is configured.

## Current flow
1. User clicks "+ Claude (ctx)"
2. `TaskPromptBuilder.buildPrompt()` builds a hardcoded prompt with task title/state/path/deadline/blocker
3. `buildClaudeArgs()` appends `additionalAgentContext` setting (if set) after the prompt
4. Final prompt passed to Claude via `-p` flag

## New flow
1. If `core.additionalAgentContext` is empty, hide the "+ Claude (ctx)" button entirely
2. When clicked, use the `additionalAgentContext` value as a **template** with placeholder substitution
3. No more hardcoded prompt from `TaskPromptBuilder` - the template IS the prompt
4. `buildClaudeArgs()` stops appending `additionalAgentContext` separately (it's already the prompt)

## Supported placeholders
- `$title` - item title
- `$state` - item state/column
- `$filePath` - full resolved file path
- `$id` - item UUID

## Changes

### 1. TerminalPanelView.ts - `renderTabBar()`
- Only render the "+ Claude (ctx)" button if `this.settings["core.additionalAgentContext"]` is non-empty

### 2. TerminalPanelView.ts - `spawnClaudeWithContext()`
- Get the template from `this.settings["core.additionalAgentContext"]`
- Resolve the full file path (expand tilde on item.path)
- Substitute placeholders in the template
- Pass the resolved template as the prompt to `buildClaudeArgs()` with `additionalAgentContext` set to empty (so it doesn't double-append)

### 3. SettingsTab.ts - description update
- Update the "Additional agent context" description to mention template placeholders

### 4. No changes to ClaudeLauncher.ts or TaskPromptBuilder
- `buildClaudeArgs()` stays as-is (it already handles prompt + optional additionalAgentContext)
- `TaskPromptBuilder` stays as-is (still used if adapter needs it elsewhere)
