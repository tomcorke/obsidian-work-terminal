# Smoke Test Strategy

[Back to README](../README.md) | [Regression tests](regression-tests.md) | [Development](development.md)

## Context

There are 126 manual regression test cases in `docs/regression-tests.md` covering terminal core, tab management, session persistence, task list, layout/detail, task operations, and implementation details. Zero are currently automated.

The isolated Obsidian instance tooling (`scripts/obsidian-isolated-instance.js`) provides vault creation, CDP-based UI interaction, and screenshot capture - sufficient for local smoke test automation. However, Obsidian is a desktop Electron app that cannot run in headless CI environments.

## What runs where

### CI (GitHub Actions) - no Obsidian required

These checks run on every PR via `.github/workflows/ci.yml`:

- **Unit tests** (`pnpm exec vitest run`) - 1290+ tests covering core logic, parsers, movers, state detection, session types, prompt builders, and framework components
- **Lint** (`pnpm run lint`) - ESLint on `src/`
- **Format check** (`pnpm run format:check`) - Prettier verification
- **Build** (`pnpm run build`) - esbuild production bundle (catches type errors, missing imports, bundle failures)

### Local only - requires Obsidian

Smoke tests require a running Obsidian instance with remote debugging enabled. They use the isolated instance tooling to:

1. Create a test vault with the plugin installed
2. Launch Obsidian on a random debug port
3. Interact via Chrome DevTools Protocol (CDP)
4. Verify UI state, capture screenshots, assert DOM conditions

## Automation approach

### Tier 1: CDP-automatable (no user interaction)

These regression tests can be driven entirely through CDP commands and filesystem manipulation. They are the first candidates for a `pnpm run test:smoke` script.

| Regression ID | Description | Automation method |
|---|---|---|
| TC-01 | PTY wrapper spawns shell | CDP: check terminal element exists after clicking Shell button |
| TC-02 | Tilde expansion | CDP: read terminal content after `pwd` command |
| TC-12 | xterm.js CSS injection | CDP: query DOM for xterm styles |
| TM-01 | Tab bar layout | CDP: query tab elements, check count |
| TL-01 | Collapsible sections | CDP: check section elements exist with correct classes |
| TL-21 | Filter input | CDP: type in filter, check visible cards |
| TL-29 | Abandoned tasks filtered | Seed abandoned task file, check it is absent from DOM |
| SP-03 | Session types tracked | Spawn Shell, Claude, and Claude(ctx) tabs, verify types |
| TO-01 | Task creation via PromptBox | CDP: type title, submit, check file created |
| LD-01 | 2-panel split layout | CDP: check panel elements exist |

### Tier 2: Requires timing/animation observation

These need CDP but also involve timing, animations, or transient states that are harder to assert reliably:

- TC-08 (double-rAF rendering), TC-10 (scroll button), TC-14 (spawn delay)
- TL-13/14/15 (state indicators), TL-16 (idle animation continuity)
- SP-01 (hot-reload survival), SP-11 (active suppression)

### Tier 3: Requires manual verification

These involve subjective visual quality or physical input that CDP cannot fully replicate:

- TC-03/04/05/06 (keyboard handling - modifier keys need OS-level input)
- LD-02 (divider drag feel), TM-02 (tab drag-and-drop)
- All section 7 "Undocumented Details" (internal implementation verification)

## Running smoke tests locally

The smoke test runner (`scripts/smoke-test-runner.js`) handles the full lifecycle automatically - it creates a clean isolated vault, seeds test data, launches Obsidian, runs all Tier 1 test assertions via CDP, reports pass/fail, and cleans up on exit.

```bash
# 1. Build the plugin first
pnpm run build

# 2. Run smoke tests (launches and manages Obsidian automatically)
pnpm run test:smoke
```

Options:
- `--no-hide` - keep the Obsidian window visible during tests (useful for debugging)
- `--timeout <ms>` - CDP command timeout in milliseconds (default: 15000)

```bash
# Run with visible window and longer timeout
pnpm run test:smoke -- --no-hide --timeout 30000
```

The runner creates and manages its own vault at `.claude/testing/smoke-tests/`. This path is reserved exclusively for smoke tests: if it already exists, the runner will remove and recreate it on each run, so do not store anything there that you want to keep. The runner also cleans up the Obsidian process even on test failure or SIGINT.

For manual step-by-step testing or debugging individual issues, you can still use the isolated instance tooling directly:

```bash
# Manual flow (for debugging or Tier 2/3 tests)
pnpm run obsidian:test:open -- --vault .claude/testing/smoke --clean
CDP_PORT=<port> node cdp.js screenshot output/test.png
pnpm run obsidian:test:stop -- --vault .claude/testing/smoke
```

## Next steps

1. **Screenshot regression** - capture baseline screenshots of key views, compare on subsequent runs using pixel diff.
2. **Integration test harness** - isolated vault + mock Claude CLI for testing agent launch/state detection flows without a real Claude binary.
3. **Tier 2 tests** - add timing/animation observation tests for double-rAF rendering, hot-reload survival, and state indicators.
