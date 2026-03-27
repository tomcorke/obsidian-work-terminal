## ADDED Requirements

### Requirement: GitHub repository exists
The system SHALL have a GitHub repository at `github.com/tomcorke/obsidian-work-terminal` cloned to `~/working/obsidian-work-terminal/`.

#### Scenario: Repository is cloned and initialised
- **WHEN** a developer clones the repository
- **THEN** the working directory `~/working/obsidian-work-terminal/` exists with a valid `.git` directory

### Requirement: package.json with correct configuration
The system SHALL have a `package.json` at the repository root with plugin metadata and build scripts.

#### Scenario: Package metadata is correct
- **WHEN** `package.json` is read
- **THEN** the `name` field is `obsidian-work-terminal`, the `version` is `0.1.0`, and `main` is `main.js`

#### Scenario: Build scripts are defined
- **WHEN** `npm run dev` is executed
- **THEN** esbuild runs in watch mode with CDP hot-reload enabled
- **WHEN** `npm run build` is executed
- **THEN** esbuild runs a production build with minification and no sourcemaps

#### Scenario: Dependencies include xterm.js
- **WHEN** `npm install` is run
- **THEN** `@xterm/xterm` and `@xterm/addon-fit` are installed as runtime dependencies
- **THEN** `esbuild`, `typescript`, `obsidian`, and `@types/node` are installed as dev dependencies

### Requirement: tsconfig.json with Obsidian-compatible settings
The system SHALL have a `tsconfig.json` targeting ES2018 with ESNext modules, strict mode enabled, and DOM lib included.

#### Scenario: TypeScript compiles successfully
- **WHEN** TypeScript files in `src/` are compiled
- **THEN** compilation succeeds with strict mode, ESNext module resolution, and ES2018 target

### Requirement: manifest.json with work-terminal plugin ID
The system SHALL have a `manifest.json` with the plugin ID `work-terminal`.

#### Scenario: Obsidian recognises the plugin
- **WHEN** Obsidian scans the plugins directory
- **THEN** it finds a plugin with `id: "work-terminal"`, `name: "Work Terminal"`, `isDesktopOnly: true`, and `minAppVersion: "1.0.0"`

### Requirement: esbuild.config.mjs builds to the correct plugin directory
The system SHALL have an `esbuild.config.mjs` that bundles `src/main.ts` to `~/working/obsidian/test-vault/Test/.obsidian/plugins/work-terminal/main.js` and copies `manifest.json` and `styles.css` to the same directory.

#### Scenario: Production build produces correct output
- **WHEN** `npm run build` is executed
- **THEN** `main.js` (minified, no sourcemap), `manifest.json`, and `styles.css` exist in the plugin output directory

#### Scenario: Watch mode triggers CDP hot-reload
- **WHEN** `npm run dev` is running and a source file changes
- **THEN** esbuild rebuilds, copies assets to the plugin directory, and sends a CDP command to execute `app.commands.executeCommandById('work-terminal:reload-plugin')` via WebSocket on port 9222

#### Scenario: Obsidian-specific modules are externalized
- **WHEN** esbuild bundles the plugin
- **THEN** `obsidian`, `electron`, `child_process`, `fs`, `path`, `os`, `string_decoder`, and all `@codemirror/*` and `@lezer/*` packages are treated as external

### Requirement: cdp.js utility for manual CDP commands
The system SHALL have a `cdp.js` script that sends arbitrary JavaScript expressions to Obsidian via CDP on port 9222.

#### Scenario: Manual hot-reload via cdp.js
- **WHEN** `node cdp.js "app.commands.executeCommandById('work-terminal:reload-plugin')"` is executed
- **THEN** the expression is evaluated in the Obsidian renderer process via CDP WebSocket

### Requirement: pty-wrapper.py ported as-is
The system SHALL have a `pty-wrapper.py` file identical to the original plugin's PTY wrapper, handling terminal spawning via Python `pty.fork()`.

#### Scenario: PTY wrapper spawns a shell
- **WHEN** a terminal tab spawns a process using `pty-wrapper.py`
- **THEN** the wrapper allocates a PTY via `pty.fork()`, proxies stdin/stdout, handles the custom resize protocol (`ESC]777;resize;COLS;ROWS BEL`), and sends SIGWINCH to the process group on resize

#### Scenario: PTY wrapper handles process exit
- **WHEN** the child process exits
- **THEN** the wrapper flushes remaining output from the master fd before exiting itself

### Requirement: CLAUDE.md with project rules
The system SHALL have a `CLAUDE.md` at the repository root documenting the project name, build workflow (`npm run dev` / `npm run build`), hot-reload rules (never use raw disable/enable or Cmd+R), commit discipline, architecture overview, known constraints (PTY, xterm CSS, tilde expansion, Node builtins, resize protocol), and the plugin output path.

#### Scenario: CLAUDE.md documents hot-reload rules
- **WHEN** a developer reads CLAUDE.md
- **THEN** it states that terminal-preserving reload MUST be used (CDP or command palette), not raw `disablePlugin/enablePlugin` or Cmd+R

### Requirement: Empty styles.css placeholder
The system SHALL have an empty `styles.css` file at the repository root that is copied to the plugin directory on each build.

#### Scenario: styles.css is copied on build
- **WHEN** esbuild completes a build
- **THEN** `styles.css` exists in the plugin output directory (may be empty)
