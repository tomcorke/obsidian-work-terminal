## ADDED Requirements

### Requirement: Window-global session stash for hot-reload
`SessionStore` MUST use `window.__taskTerminalStore` to stash and retrieve live session objects (Terminal, PTY process, DOM elements) across module re-evaluations during hot-reload.

#### Scenario: Stash stores live objects
- **WHEN** `stash()` is called on a TerminalTab
- **THEN** a `StoredSession` is returned containing references to the live `Terminal`, `FitAddon`, `containerEl`, `ChildProcess`, `documentListeners`, and `ResizeObserver` objects

#### Scenario: State timer stopped during stash
- **WHEN** `stash()` is called on a TerminalTab with an active state tracking timer
- **THEN** the timer is cleared before creating the StoredSession (prevents state checks referencing stale session objects during reload)

#### Scenario: Window store deleted after retrieval
- **WHEN** `SessionStore.retrieve()` reads the window-global store
- **THEN** `window.__taskTerminalStore` is deleted immediately after reading to prevent accidental reuse on subsequent reloads

#### Scenario: Restore re-attaches DOM and listeners
- **WHEN** `TerminalTab.fromStored()` is called with a StoredSession and a new parent element
- **THEN** the stored containerEl is appended to the new parent, bubble-phase and capture-phase keyboard listeners are re-registered, click-to-focus is re-attached, the scroll-to-bottom button is re-created, and the ResizeObserver is reconnected

### Requirement: Disk persistence with versioned schema
`SessionPersistence` MUST persist session metadata to Obsidian's `data.json` using a `version: 1` schema for forward-compatible migration.

#### Scenario: Persisted session includes version field
- **WHEN** a session is serialized for disk persistence
- **THEN** the `PersistedSession` record includes `version: 1`

#### Scenario: Serialization round-trip preserves all fields
- **WHEN** a session with id, taskPath, label, claudeSessionId, and sessionType is serialized and deserialized
- **THEN** all fields are preserved exactly

#### Scenario: loadData merge before saveData
- **WHEN** sessions are persisted to disk
- **THEN** existing plugin data is read first, sessions are merged, and written once to preserve unrelated settings

### Requirement: 7-day retention for Claude sessions
Disk-persisted Claude sessions MUST be retained for 7 days to allow resume after extended absences. Non-Claude sessions are not persisted to disk.

#### Scenario: Claude session persisted on spawn
- **WHEN** a new Claude session is spawned with a UUID session ID
- **THEN** the session metadata (taskPath, sessionId, label, timestamp) is persisted to disk

#### Scenario: Sessions older than 7 days pruned
- **WHEN** persisted sessions are loaded from disk
- **THEN** sessions with timestamps older than 7 days are removed

#### Scenario: Shell sessions not persisted to disk
- **WHEN** a plain shell terminal is spawned (not a Claude session)
- **THEN** no disk persistence entry is created for it

### Requirement: UUID session IDs for Claude resume
Claude sessions MUST be assigned a UUID via `--session-id` at spawn time, enabling resume via `claude --resume <id>` after restart.

#### Scenario: UUID assigned at Claude spawn
- **WHEN** a new Claude session is spawned
- **THEN** a UUID is generated and passed as `--session-id <uuid>` in the command arguments

#### Scenario: Resume uses persisted session ID
- **WHEN** a persisted Claude session is resumed
- **THEN** the command includes `--resume` and `--session-id <original-uuid>`

#### Scenario: Tab label preserved on resume
- **WHEN** a Claude session is resumed from disk persistence
- **THEN** the original tab label from the persisted session is restored

### Requirement: 5-second grace period on resume failure
When a resumed Claude session exits immediately (within 5 seconds), the persisted entry MUST be kept for retry rather than cleaned up.

#### Scenario: Immediate exit preserves entry
- **WHEN** a resumed Claude session's process exits within 5 seconds of spawn
- **THEN** the persisted session entry is NOT removed from disk, allowing the user to retry

#### Scenario: Normal exit after grace period cleans up
- **WHEN** a resumed Claude session runs for more than 5 seconds and then exits
- **THEN** the persisted session entry is removed from disk on cleanup
