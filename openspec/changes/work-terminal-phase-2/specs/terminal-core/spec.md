## ADDED Requirements

### Requirement: PTY spawning via Python wrapper
The terminal MUST spawn child processes through `pty-wrapper.py` using `python3` to work around Electron's `pty.spawn()` sandbox restriction. The spawn MUST use `child_process.spawn` obtained via `window.require` (Electron context).

#### Scenario: Shell terminal spawned with correct dimensions
- **WHEN** a new shell terminal is created with a container that measures 120 columns and 40 rows
- **THEN** `python3 pty-wrapper.py 120 40 -- /bin/zsh -i` is spawned with `stdio: ["pipe", "pipe", "pipe"]`, `TERM=xterm-256color`, and the expanded cwd

#### Scenario: Tilde expansion on spawn cwd
- **WHEN** a terminal is created with cwd `~/working/my-project`
- **THEN** the cwd passed to spawn is expanded to `${process.env.HOME}/working/my-project`

#### Scenario: Tilde-only cwd expansion
- **WHEN** a terminal is created with cwd `~`
- **THEN** the cwd passed to spawn is expanded to `${process.env.HOME}`

#### Scenario: Delayed spawn for CSS layout
- **WHEN** a new TerminalTab is constructed
- **THEN** the PTY process spawn is deferred by 150ms to allow CSS layout to complete before measuring terminal dimensions

#### Scenario: Unique terminal IDs under rapid spawn
- **WHEN** two terminals are created within the same millisecond
- **THEN** each terminal receives a unique ID using a timestamp + incrementing counter pattern

### Requirement: xterm.js CSS singleton injection
The `XtermCss` module MUST inject the full xterm.js CSS into the document head exactly once, since `require.resolve` is unavailable in Obsidian's bundle context.

#### Scenario: First terminal injection
- **WHEN** the first terminal is created in the session
- **THEN** a `<style>` element with id `xterm-css` containing the full xterm.js CSS is appended to `document.head`

#### Scenario: Subsequent terminal creation
- **WHEN** a second terminal is created after CSS has already been injected
- **THEN** no duplicate `<style>` element is created

### Requirement: Two-layer keyboard interception
`KeyboardCapture` MUST implement both bubble-phase and capture-phase keyboard interception to prevent Obsidian from stealing terminal keystrokes.

#### Scenario: Bubble-phase stops Obsidian hotkeys
- **WHEN** a keydown or keyup event fires inside the terminal container
- **THEN** `stopPropagation()` is called in bubble phase to prevent Obsidian's bubble-phase handlers from processing it

#### Scenario: Capture-phase intercepts Shift+Enter
- **WHEN** Shift+Enter is pressed while the terminal's helper textarea is focused
- **THEN** the CSI u sequence `\x1b[13;2u` is written directly to PTY stdin, and the event is stopped with `stopImmediatePropagation()` and `preventDefault()`

#### Scenario: Capture-phase intercepts Option+Arrow keys
- **WHEN** Option+ArrowLeft is pressed while the terminal's helper textarea is focused
- **THEN** `\x1bb` (ESC b - word backward) is written to PTY stdin and the event is killed
- **WHEN** Option+ArrowRight is pressed while the terminal's helper textarea is focused
- **THEN** `\x1bf` (ESC f - word forward) is written to PTY stdin and the event is killed

#### Scenario: Capture-phase intercepts Option+Backspace
- **WHEN** Option+Backspace is pressed while the terminal's helper textarea is focused
- **THEN** `\x1b\x7f` (ESC DEL - delete word backward) is written to PTY stdin and the event is killed

#### Scenario: Non-terminal focus ignores capture
- **WHEN** Shift+Enter is pressed while focus is outside the terminal's helper textarea
- **THEN** the capture-phase handler takes no action and does not interfere with the event

### Requirement: macOptionIsMeta for word navigation
The xterm.js Terminal MUST be configured with `macOptionIsMeta: true` to enable Option-key word navigation in shells and CLI tools.

#### Scenario: Terminal option configuration
- **WHEN** a new Terminal instance is created
- **THEN** the `macOptionIsMeta` option is set to `true`

### Requirement: Custom OSC resize protocol
The terminal MUST send resize commands to `pty-wrapper.py` via the custom OSC sequence `ESC]777;resize;COLS;ROWS BEL` through PTY stdin. A `ResizeObserver` on the container MUST trigger refit.

#### Scenario: Terminal resize triggers OSC sequence
- **WHEN** the xterm.js terminal fires an `onResize` event with cols=100 and rows=30
- **THEN** the string `\x1b]777;resize;100;30\x07` is written to the PTY process stdin

#### Scenario: ResizeObserver triggers refit
- **WHEN** the terminal container element is resized
- **THEN** `fitAddon.fit()` is called inside a `requestAnimationFrame` callback

#### Scenario: Hidden terminal skips refit
- **WHEN** the terminal container has the `hidden` class and a resize event fires
- **THEN** the `fitAddon.fit()` call is skipped to avoid zero-dimension errors

#### Scenario: Fit errors are silently caught
- **WHEN** `fitAddon.fit()` throws during a lifecycle transition
- **THEN** the error is caught and suppressed without propagating

### Requirement: Double-rAF on tab show
When a terminal tab becomes visible, the fit measurement MUST use two nested `requestAnimationFrame` calls to get correct dimensions.

#### Scenario: Tab show triggers double-rAF fit
- **WHEN** `show()` is called on a hidden terminal tab
- **THEN** the container's `hidden` class is removed, and inside two nested `requestAnimationFrame` callbacks, `fitAddon.fit()` is called followed by `terminal.scrollToBottom()` and `terminal.focus()`

### Requirement: Scroll-to-bottom overlay button
A scroll-to-bottom button MUST appear when the terminal is scrolled up and hide when at the bottom.

#### Scenario: Button appears on scroll up
- **WHEN** the terminal viewport is scrolled above the bottom (viewportY < baseY)
- **THEN** a button with class `terminal-scroll-bottom` and aria-label "Scroll to bottom" is displayed

#### Scenario: Button hidden at bottom
- **WHEN** the terminal viewport is at the bottom (viewportY >= baseY)
- **THEN** the scroll-to-bottom button is hidden

#### Scenario: Button click scrolls and focuses
- **WHEN** the scroll-to-bottom button is clicked
- **THEN** `terminal.scrollToBottom()` and `terminal.focus()` are called, and the click event does not propagate

#### Scenario: Existing button removed on reload
- **WHEN** `attachScrollButton` is called on a container that already has a `.terminal-scroll-bottom` element
- **THEN** the existing button is removed before creating the new one

### Requirement: Terminal process lifecycle
The terminal MUST handle process exit and disposal cleanly.

#### Scenario: Process exit callback
- **WHEN** the spawned PTY process exits with code 0 and signal null
- **THEN** `[Process exited (code: 0, signal: null)]` is written to the terminal and the `onProcessExit` callback fires

#### Scenario: SIGTERM then SIGKILL on dispose
- **WHEN** `dispose()` is called on a terminal with a running process
- **THEN** SIGTERM is sent immediately, and if the process has not exited after 1 second, SIGKILL is sent

#### Scenario: Dispose cleans up all resources
- **WHEN** `dispose()` is called on a terminal
- **THEN** the state tracking timer is cleared, document-level keyboard listeners are removed, the ResizeObserver is disconnected, the terminal is disposed, and the container element is removed from the DOM

### Requirement: Screen reading via cursor position
Terminal screen content MUST be read using `baseY + cursorY` to find the content end, not the buffer bottom.

#### Scenario: Content read uses cursor position
- **WHEN** the terminal screen is read for state detection
- **THEN** lines are read from `max(0, contentEnd - 30)` to `contentEnd` where `contentEnd = buf.baseY + buf.cursorY + 2`, not from the bottom of `buf.length`
