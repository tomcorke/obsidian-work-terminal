## 1. Vitest Setup

- [ ] 1.1 Add `vitest` as a dev dependency in `package.json`
- [ ] 1.2 Create `vitest.config.ts` with TypeScript support, targeting `src/**/*.test.ts`
- [ ] 1.3 Add `"test": "vitest run"` and `"test:watch": "vitest"` scripts to `package.json`

## 2. Core Utils

- [ ] 2.1 Create `src/core/utils.ts` with `expandTilde` function - expands leading `~` to `process.env.HOME` (fallback `USERPROFILE`), returns unchanged for non-tilde paths
- [ ] 2.2 Add `stripAnsi` function to `src/core/utils.ts` - two-stage ANSI stripping: (1) replace CSI cursor-forward `ESC[nC` with n spaces, (2) strip all remaining ANSI/control sequences except tab/newline/carriage-return
- [ ] 2.3 Add `electronRequire` function to `src/core/utils.ts` - wraps `window.require` with fallback to `require` for non-Electron environments
- [ ] 2.4 Add `slugify` function to `src/core/utils.ts` - lowercase, replace non-alphanumeric runs with hyphens, strip leading/trailing hyphens, truncate to 40 chars, strip trailing hyphen from truncation

## 3. Core Interfaces

- [ ] 3.1 Create `src/core/interfaces.ts` with `WorkItem` interface (`id`, `path`, `title`, `state`, `metadata`)
- [ ] 3.2 Add `ListColumn` interface (`id`, `label`, `folderName`) and `CreationColumn` interface (`id`, `label`, `default?`)
- [ ] 3.3 Add `SettingField` interface (`key`, `name`, `description`, `type`, `default`)
- [ ] 3.4 Add `PluginConfig` interface (`columns`, `creationColumns`, `settingsSchema`, `defaultSettings`, `itemName`)
- [ ] 3.5 Add `WorkItemParser` interface (`basePath`, `parse`, `loadAll`, `groupByColumn`, `isItemFile`)
- [ ] 3.6 Add `WorkItemMover` interface (`move`)
- [ ] 3.7 Add `CardActionContext` interface (`onSelect`, `onMoveToTop`, `onMoveToColumn`, `onInsertAfter`, `onDelete`, `onCloseSessions`)
- [ ] 3.8 Add `CardRenderer` interface (`render`, `getContextMenuItems`)
- [ ] 3.9 Add `WorkItemPromptBuilder` interface (`buildPrompt`)
- [ ] 3.10 Add `AdapterBundle` interface (required: `config`, `createParser`, `createMover`, `createCardRenderer`, `createPromptBuilder`; optional: `createDetailView`, `onItemCreated`, `transformSessionLabel`)
- [ ] 3.11 Add `BaseAdapter` abstract class implementing `AdapterBundle` with defaults for optional methods

## 4. Utils Tests

- [ ] 4.1 Create `src/core/utils.test.ts` with `expandTilde` tests: tilde-slash expansion, bare tilde, no-op for absolute paths, no-op for mid-path tilde, USERPROFILE fallback, unchanged when no home env
- [ ] 4.2 Add `stripAnsi` tests: simple colour code stripping, cursor-forward to spaces, OSC stripping, plain text passthrough, empty string, control character stripping, tab/newline preservation
- [ ] 4.3 Add `slugify` tests: simple title, special characters, long title truncation (max 40 chars, no trailing hyphen), leading/trailing special chars, empty string, already-valid slug, consecutive special chars collapsed

## 5. Build Verification

- [ ] 5.1 Run `npm run build` and verify esbuild succeeds with no errors
- [ ] 5.2 Run `npm test` and verify all vitest tests pass
