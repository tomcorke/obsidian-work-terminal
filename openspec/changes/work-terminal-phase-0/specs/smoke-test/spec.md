## ADDED Requirements

### Requirement: Plugin registers and activates in Obsidian
The system SHALL export a default class extending `Plugin` from `src/main.ts` that registers an `ItemView` with a unique view type identifier and adds a ribbon icon or command to open the view.

#### Scenario: Plugin loads without errors
- **WHEN** Obsidian loads the `work-terminal` plugin
- **THEN** the plugin activates without throwing errors and registers its view type

#### Scenario: Plugin registers a reload command
- **WHEN** the plugin activates
- **THEN** it registers a command `work-terminal:reload-plugin` that performs a terminal-preserving hot-reload (disable then re-enable the plugin)

### Requirement: ItemView renders a split layout container
The system SHALL provide an `ItemView` subclass that renders a container element with a basic two-panel split layout (left panel placeholder, right terminal panel).

#### Scenario: View opens with split layout
- **WHEN** the user opens the Work Terminal view
- **THEN** the view renders a container with two side-by-side panels using CSS flexbox
- **THEN** the left panel is an empty placeholder div (for the future list panel)
- **THEN** the right panel contains a terminal instance

### Requirement: xterm.js terminal renders in the right panel
The system SHALL create an xterm.js `Terminal` instance with `FitAddon`, attach it to the right panel DOM element, and spawn a shell process via `pty-wrapper.py`.

#### Scenario: Terminal renders and is interactive
- **WHEN** the view opens and the right panel is visible
- **THEN** an xterm.js terminal is rendered in the right panel
- **THEN** the terminal displays a shell prompt (spawned via `pty-wrapper.py`)
- **THEN** the user can type commands and see output

#### Scenario: xterm.js CSS is injected inline
- **WHEN** the terminal is first created
- **THEN** the xterm.js CSS is injected as a `<style>` element in the document head (since `require.resolve` is unavailable in the bundled context)
- **THEN** the style element is only injected once even if multiple terminals are created

#### Scenario: Terminal resizes with container
- **WHEN** the terminal's container element is resized
- **THEN** `FitAddon.fit()` is called (via ResizeObserver or equivalent) and the new dimensions are sent to the PTY wrapper via the resize protocol (`ESC]777;resize;COLS;ROWS BEL`)

### Requirement: PTY process spawns correctly
The system SHALL spawn the PTY wrapper using `child_process.spawn` with Python 3 and `pty-wrapper.py`, passing the shell command and initial working directory. The tilde in any path MUST be expanded via `process.env.HOME` before spawning.

#### Scenario: Shell spawns with correct working directory
- **WHEN** a terminal is created
- **THEN** `pty-wrapper.py` is spawned with the user's default shell
- **THEN** the working directory is set to the user's home directory (or a configured path)

#### Scenario: Tilde expansion in spawn paths
- **WHEN** any path containing `~` is passed to the spawn function
- **THEN** `~` is replaced with the value of `process.env.HOME` before the path is used

### Requirement: Build produces a loadable plugin
The system SHALL produce a valid Obsidian plugin when `npm run build` is executed, consisting of `main.js`, `manifest.json`, and `styles.css` in the plugin output directory.

#### Scenario: End-to-end build and load
- **WHEN** `npm run build` is executed from the repository root
- **THEN** the build succeeds without errors
- **THEN** `main.js`, `manifest.json`, and `styles.css` exist in `~/working/obsidian/test-vault/Test/.obsidian/plugins/work-terminal/`
- **THEN** Obsidian can load and activate the plugin from this directory

### Requirement: CDP hot-reload works in watch mode
The system SHALL trigger a terminal-preserving hot-reload in Obsidian after each successful rebuild in watch mode, using CDP on port 9222.

#### Scenario: Source change triggers reload
- **WHEN** `npm run dev` is running and a TypeScript source file is saved
- **THEN** esbuild rebuilds the bundle
- **THEN** the CDP mechanism sends `app.commands.executeCommandById('work-terminal:reload-plugin')` to Obsidian
- **THEN** the plugin reloads without destroying terminal state
