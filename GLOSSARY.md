# Glossary

Canonical terms for obsidian-work-terminal.

- **Work item** - Adapter-owned unit displayed on the board. Task-agent adapter uses task files.
- **Task** - Task-agent work item represented by a Markdown file and frontmatter metadata.
- **Terminal tab** - PTY-backed terminal session associated with one task.
- **Agent session** - Terminal tab running an AI coding agent.
- **Terminal panel** - Work Terminal UI area containing tabs for the selected task.
- **Task board** - Kanban-style list of work items grouped by state.
- **Adapter** - Work-item integration implementing parsing, moving, rendering, prompting, and configuration.
- **Framework** - Shared plugin layer managing views, terminal infrastructure, agent integration, persistence, and UI behavior.
- **Agent profile** - Configured command, arguments, working directory, and launch behavior for an agent session.
