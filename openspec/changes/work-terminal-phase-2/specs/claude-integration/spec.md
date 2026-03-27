## ADDED Requirements

### Requirement: Claude binary resolution and PATH augmentation
`ClaudeLauncher` MUST resolve the Claude binary path and augment Electron's limited PATH to find CLI tools installed in user profile directories.

#### Scenario: PATH augmentation for Electron
- **WHEN** the ClaudeLauncher builds the spawn environment
- **THEN** the PATH is augmented by prepending `~/.local/bin`, `~/.nvm/versions/node/current/bin`, `/usr/local/bin`, `/opt/homebrew/bin` to the existing PATH, with duplicates removed via `Set`

#### Scenario: resolveCommand for non-absolute claudeCommand
- **WHEN** the `claudeCommand` setting is `claude` (not an absolute path)
- **THEN** `resolveCommand()` searches the augmented PATH directories for a matching executable and returns the full path

#### Scenario: Absolute claudeCommand path used directly
- **WHEN** the `claudeCommand` setting is `/usr/local/bin/claude`
- **THEN** the path is used directly without PATH resolution

#### Scenario: Claude arg building from settings
- **WHEN** a Claude session is spawned with `claudeExtraArgs` setting "-- --verbose --no-cache" and `additionalAgentContext` setting "Focus on TypeScript"
- **THEN** the command args include the extra args split on whitespace, and the additional context is appended to the adapter-provided prompt

### Requirement: Claude state detection from xterm buffer
`ClaudeStateDetector` MUST determine Claude's state by reading the rendered xterm buffer, not raw stdout, to avoid false positives from status bar redraws.

#### Scenario: Active state detected from spinner with ellipsis
- **WHEN** the last 6 lines of the terminal screen contain a line matching `^\s*\u2733.*\u2026` (spinner character with ellipsis)
- **THEN** the state is reported as `active`

#### Scenario: Active state detected from tool output with ellipsis
- **WHEN** the last 6 lines of the terminal screen contain a line matching `^\s*⎿\s+.*\u2026` (tool output marker with ellipsis)
- **THEN** the state is reported as `active`

#### Scenario: Idle state when no active indicators
- **WHEN** the last 6 lines of the terminal screen contain no active indicator patterns
- **THEN** the state is reported as `idle` and the active suppression timer is cleared

#### Scenario: Only last 6 lines checked for active indicators
- **WHEN** line 20 of the terminal contains a spinner with ellipsis but the last 6 lines do not
- **THEN** the state is NOT reported as `active` (avoids false-positives on Claude's response text)

#### Scenario: State check interval
- **WHEN** state tracking is started for a Claude session
- **THEN** the state is checked every 2 seconds via `setInterval`

### Requirement: Waiting state detection
The state detector MUST identify when Claude is waiting for user input by checking both the terminal screen buffer and recent output lines.

#### Scenario: Interactive selection UI detected as waiting
- **WHEN** recent screen lines contain "Enter to select" or "to navigate"
- **THEN** the state is reported as `waiting`

#### Scenario: Permission prompt detected as waiting
- **WHEN** recent screen lines contain "Allow ...?" or "allowOnce" / "denyOnce" / "allowAlways"
- **THEN** the state is reported as `waiting`

#### Scenario: Multi-line question detected as waiting
- **WHEN** a line contains numbered options (e.g. `> 1. Option text`) or a line with a number is preceded by a `?`-ending line within 5 lines
- **THEN** the state is reported as `waiting`

#### Scenario: Generic question near bottom detected as waiting
- **WHEN** one of the last 5 lines ends with `?` and is longer than 10 characters
- **THEN** the state is reported as `waiting`

#### Scenario: Visible tab suppresses waiting to idle
- **WHEN** the terminal tab is currently visible and a waiting pattern is detected
- **THEN** the state is reported as `idle` instead of `waiting` (user can already see the prompt)

### Requirement: State aggregation across tabs
State aggregation for a work item with multiple tabs MUST follow priority: `waiting > active > idle > inactive`.

#### Scenario: Waiting takes priority over active
- **WHEN** a work item has two Claude tabs, one `active` and one `waiting`
- **THEN** the aggregated state for the work item is `waiting`

#### Scenario: Short-circuit on first waiting
- **WHEN** a work item has five tabs and the first is `waiting`
- **THEN** aggregation returns `waiting` immediately without checking remaining tabs

#### Scenario: Active takes priority over idle
- **WHEN** a work item has tabs in `active` and `idle` states
- **THEN** the aggregated state is `active`

#### Scenario: No Claude sessions yields inactive
- **WHEN** a work item has only shell tabs (no Claude sessions)
- **THEN** the aggregated state is `inactive`

### Requirement: Post-reload active suppression
After restoring a session from hot-reload stash, active detection MUST be suppressed for 2 seconds to prevent stale buffer content from triggering false active indicators.

#### Scenario: Active suppressed during grace period
- **WHEN** a session is restored via `fromStored` and the buffer shows active indicators within the first 2 seconds
- **THEN** the state is reported as `idle` instead of `active`

#### Scenario: Genuine screen update clears suppression early
- **WHEN** active indicators disappear from the screen during the grace period (buffer genuinely updated)
- **THEN** the `_suppressActiveUntil` timestamp is cleared to 0, ending suppression early

#### Scenario: Fresh spawns unaffected
- **WHEN** a new Claude session is spawned (not restored from stash)
- **THEN** `_suppressActiveUntil` is 0 and active detection works immediately

### Requirement: Pre-seeded idleSince on reload
Recovered Claude sessions MUST have `idleSince` pre-seeded to `Date.now() - 300_000` so idle animations start fully stale.

#### Scenario: Recovered session starts fully stale
- **WHEN** a Claude session is recovered from hot-reload stash
- **THEN** the `idleSince` for that work item is set to 300 seconds in the past

### Requirement: Claude session rename detection
`ClaudeSessionRename` MUST monitor the output stream for "Session renamed to:" patterns, strip ANSI sequences, handle UTF-8 chunk boundaries, and invoke the adapter's `transformSessionLabel` hook.

#### Scenario: Rename detected on complete line
- **WHEN** the output stream contains `\u2514 Session renamed to: my-feature\n` (with ANSI wrapping)
- **THEN** the session label is updated to `my-feature` and `onLabelChange` fires

#### Scenario: Rename detected on incomplete line (no trailing newline)
- **WHEN** the output buffer contains the rename pattern without a trailing newline
- **THEN** the rename is still detected from the incomplete buffer

#### Scenario: Three-stage ANSI stripping
- **WHEN** the output contains CSI cursor-forward sequences (`ESC[nC`) mixed with content
- **THEN** cursor-forward sequences are replaced with equivalent spaces (preserving alignment) before remaining ANSI/control sequences are stripped

#### Scenario: UTF-8 multi-byte characters across chunk boundaries
- **WHEN** a multi-byte UTF-8 character (e.g. `+`) is split across two data chunks
- **THEN** `StringDecoder` reassembles the character correctly before pattern matching

#### Scenario: Adapter transform hook called
- **WHEN** a session rename is detected and the adapter provides `transformSessionLabel`
- **THEN** the hook is called with the old and detected labels, and its return value becomes the new label

### Requirement: Headless Claude spawning
`HeadlessClaude` MUST provide a `spawnHeadlessClaude(prompt, cwd)` utility for adapter background operations.

#### Scenario: Headless spawn uses resolved Claude binary
- **WHEN** `spawnHeadlessClaude` is called with a prompt and cwd
- **THEN** the Claude binary is resolved via `ClaudeLauncher`, spawned with the prompt as input, and the result is returned

#### Scenario: Headless spawn uses augmented PATH
- **WHEN** a headless Claude process is spawned
- **THEN** the same PATH augmentation used by interactive Claude sessions is applied
