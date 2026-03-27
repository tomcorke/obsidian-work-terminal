## ADDED Requirements

### Requirement: expandTilde utility

The `expandTilde` function SHALL accept a string path and return the path with a leading `~` replaced by `process.env.HOME`.

The function SHALL handle three cases:
- Paths starting with `~/` SHALL have `~` replaced with the HOME directory
- A path that is exactly `~` SHALL be replaced with the HOME directory
- All other paths SHALL be returned unchanged

The function SHALL fall back to `process.env.USERPROFILE` if `process.env.HOME` is undefined.

The function SHALL return the original path unchanged if neither `HOME` nor `USERPROFILE` is set.

#### Scenario: Expands tilde with slash
- **WHEN** the input is `~/Documents/notes`
- **THEN** the output is `/home/user/Documents/notes` (where `/home/user` is `process.env.HOME`)

#### Scenario: Expands bare tilde
- **WHEN** the input is `~`
- **THEN** the output is `/home/user` (the value of `process.env.HOME`)

#### Scenario: Does not expand tilde in middle of path
- **WHEN** the input is `/some/~path`
- **THEN** the output is `/some/~path` (unchanged)

#### Scenario: Does not expand absolute path
- **WHEN** the input is `/usr/local/bin`
- **THEN** the output is `/usr/local/bin` (unchanged)

#### Scenario: Falls back to USERPROFILE
- **WHEN** `process.env.HOME` is undefined and `process.env.USERPROFILE` is `C:\Users\me`
- **THEN** `~/file` expands to `C:\Users\me/file`

#### Scenario: Returns original when no home directory
- **WHEN** both `process.env.HOME` and `process.env.USERPROFILE` are undefined
- **THEN** `~/file` is returned as `~/file` (unchanged)

---

### Requirement: stripAnsi utility

The `stripAnsi` function SHALL accept a string and return a clean version with all ANSI escape sequences and control characters removed.

The function SHALL use a two-stage approach:
1. **Stage 1**: Replace CSI cursor-forward sequences (`ESC[nC`) with `n` space characters to preserve text alignment
2. **Stage 2**: Strip all remaining ANSI escape sequences (CSI, OSC, other ESC sequences) and non-printable control characters (except newline, carriage return, and tab)

#### Scenario: Strips simple colour codes
- **WHEN** the input contains `"\x1b[31mred text\x1b[0m"`
- **THEN** the output is `"red text"`

#### Scenario: Preserves cursor-forward alignment
- **WHEN** the input contains `"hello\x1b[5Cworld"` (cursor forward 5)
- **THEN** the output is `"hello     world"` (5 spaces replacing the cursor-forward)

#### Scenario: Strips OSC sequences
- **WHEN** the input contains OSC sequences (e.g., `"\x1b]777;resize;80;24\x07"`)
- **THEN** the OSC sequence is removed entirely

#### Scenario: Returns plain text unchanged
- **WHEN** the input is `"plain text with no escapes"`
- **THEN** the output is `"plain text with no escapes"`

#### Scenario: Handles empty string
- **WHEN** the input is `""`
- **THEN** the output is `""`

#### Scenario: Strips control characters
- **WHEN** the input contains non-printable control characters (e.g., `\x00`, `\x08`, `\x0e`)
- **THEN** those characters are removed

#### Scenario: Preserves tabs and newlines
- **WHEN** the input contains tab (`\t`) and newline (`\n`) characters
- **THEN** tabs and newlines are preserved in the output

---

### Requirement: electronRequire utility

The `electronRequire` function SHALL accept a module name string and return the result of requiring that module in the Electron/Obsidian context.

The function SHALL use `window.require` when available (Electron runtime), falling back to Node's `require` when `window.require` is not defined (test environment or non-Electron context).

This function SHALL be the single point of access for Node built-in modules (`child_process`, `fs`, `path`, `os`) throughout the plugin codebase.

#### Scenario: Uses window.require in Electron
- **WHEN** `window.require` is defined (Obsidian/Electron runtime)
- **THEN** the function calls `window.require(moduleName)` and returns its result

#### Scenario: Falls back to require outside Electron
- **WHEN** `window.require` is not defined (test or non-Electron environment)
- **THEN** the function calls `require(moduleName)` and returns its result

---

### Requirement: slugify utility

The `slugify` function SHALL accept a string and return a URL/filename-safe kebab-case slug.

The function SHALL apply these transformations in order:
1. Convert to lowercase
2. Replace runs of non-alphanumeric characters with a single hyphen
3. Strip leading and trailing hyphens
4. Truncate to 40 characters maximum
5. Strip any trailing hyphen created by truncation

#### Scenario: Simple title
- **WHEN** the input is `"My Task Title"`
- **THEN** the output is `"my-task-title"`

#### Scenario: Special characters replaced
- **WHEN** the input is `"Fix bug #123 (urgent!)"`
- **THEN** the output is `"fix-bug-123-urgent"`

#### Scenario: Long title truncated cleanly
- **WHEN** the input is `"this is a very long title that exceeds the forty character limit"`
- **THEN** the output is at most 40 characters, does not end with a hyphen, and is a valid slug

#### Scenario: Leading and trailing special characters
- **WHEN** the input is `"---hello world---"`
- **THEN** the output is `"hello-world"`

#### Scenario: Empty string
- **WHEN** the input is `""`
- **THEN** the output is `""`

#### Scenario: Already valid slug
- **WHEN** the input is `"already-valid"`
- **THEN** the output is `"already-valid"`

#### Scenario: Consecutive special characters collapsed
- **WHEN** the input is `"hello!!!...world"`
- **THEN** the output is `"hello-world"` (single hyphen, not multiple)
