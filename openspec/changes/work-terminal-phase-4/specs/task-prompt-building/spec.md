## ADDED Requirements

### Requirement: Build context prompt for Claude sessions
The TaskPromptBuilder SHALL implement WorkItemPromptBuilder and generate a lightweight context string for Claude sessions. The prompt SHALL include the task title, current state (one of: priority, todo, active, done, abandoned - guaranteed valid by the parser), and full file path.

#### Scenario: Basic prompt
- **WHEN** buildPrompt is called with a task titled "Fix login bug" in state "active" at path "2 - Areas/Tasks/active/TASK-20260327-fix-login-bug.md"
- **THEN** the prompt includes the title, state, and path

### Requirement: Include deadline when present
The prompt SHALL include the deadline from `priority.deadline` when it is a non-empty string.

#### Scenario: Task with deadline
- **WHEN** buildPrompt is called with a task that has `priority.deadline: "2026-04-01"`
- **THEN** the prompt includes `Deadline: 2026-04-01`

#### Scenario: Task without deadline
- **WHEN** buildPrompt is called with a task that has an empty or missing deadline
- **THEN** the prompt does not mention a deadline

### Requirement: Include blocker context when present
The prompt SHALL include the blocker context from `priority.blocker-context` when `priority.has-blocker` is true and context is non-empty.

#### Scenario: Task with blocker
- **WHEN** buildPrompt is called with a task that has `has-blocker: true` and `blocker-context: "Waiting on API team"`
- **THEN** the prompt includes `Blocker: Waiting on API team`

#### Scenario: Task without blocker
- **WHEN** buildPrompt is called with a task that has `has-blocker: false`
- **THEN** the prompt does not mention a blocker

### Requirement: Handle special characters in prompt
The prompt SHALL not crash or produce garbled output when task metadata contains quotes, colons, or other special characters.

#### Scenario: Title with special characters
- **WHEN** buildPrompt is called with a title containing `"Fix: the 'auth' bug"`
- **THEN** the prompt includes the title verbatim without escaping issues
