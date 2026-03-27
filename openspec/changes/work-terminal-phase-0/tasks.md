## 1. Repository Setup

- [ ] 1.1 Create `obsidian-work-terminal` repo on `github.com/tomcorke` (public, no template, MIT license)
- [ ] 1.2 Clone to `~/working/obsidian-work-terminal/` and initialise with a `.gitignore` (node_modules, dist, *.js in root except config files)

## 2. Project Configuration

- [ ] 2.1 Create `package.json` with name `obsidian-work-terminal`, version `0.1.0`, scripts (`dev`: esbuild watch, `build`: esbuild production), dependencies (`@xterm/xterm`, `@xterm/addon-fit`), devDependencies (`esbuild`, `typescript`, `obsidian`, `@types/node`)
- [ ] 2.2 Create `tsconfig.json` targeting ES2018, ESNext modules, strict mode, DOM lib, rootDir `src/`, outDir `dist/`
- [ ] 2.3 Create `manifest.json` with id `work-terminal`, name `Work Terminal`, version `0.1.0`, minAppVersion `1.0.0`, isDesktopOnly `true`, author `Tom Corke`
- [ ] 2.4 Create empty `styles.css` placeholder at repository root
- [ ] 2.5 Run `npm install` and verify all dependencies resolve

## 3. Build Tooling

- [ ] 3.1 Port `esbuild.config.mjs` from original plugin - update plugin dir to `plugins/work-terminal`, command ID to `work-terminal:reload-plugin`, keep all Obsidian externals, remove any CSS module handling
- [ ] 3.2 Port `cdp.js` from original plugin - update default command to `work-terminal:reload-plugin`
- [ ] 3.3 Verify `npm run build` succeeds and outputs `main.js`, `manifest.json`, `styles.css` to `~/working/obsidian/test-vault/Test/.obsidian/plugins/work-terminal/`

## 4. PTY Wrapper

- [ ] 4.1 Copy `pty-wrapper.py` from original plugin (`~/working/claude-sandbox/obsidian-task-terminal/pty-wrapper.py`) to repository root - no modifications needed

## 5. Minimal Plugin Implementation

- [ ] 5.1 Create `src/main.ts` - export default Plugin subclass that registers an ItemView type (`work-terminal-view`), adds a ribbon icon to open the view, and registers the `work-terminal:reload-plugin` command (disable + re-enable plugin)
- [ ] 5.2 Create the ItemView subclass (in `src/main.ts` or separate file) with `getViewType()`, `getDisplayText()`, and `onOpen()` that renders a two-panel flex container (left placeholder div, right terminal div)
- [ ] 5.3 Implement xterm.js CSS injection - singleton pattern that injects the full xterm CSS as a `<style>` element in the document head on first terminal creation
- [ ] 5.4 Implement terminal creation in the right panel - create xterm.js `Terminal` + `FitAddon`, attach to DOM, spawn shell via `pty-wrapper.py` using `child_process.spawn` (with tilde expansion on all paths), wire stdin/stdout, call `fit()` after attach
- [ ] 5.5 Implement resize handling - `ResizeObserver` on terminal container triggers `FitAddon.fit()` and sends resize dimensions to PTY via the OSC protocol (`ESC]777;resize;COLS;ROWS BEL`)
- [ ] 5.6 Implement cleanup in `onClose()` - kill PTY process, dispose xterm terminal

## 6. Project Documentation

- [ ] 6.1 Create `CLAUDE.md` documenting: project name/description, build workflow (`npm run dev`/`npm run build`), hot-reload rules (MUST use CDP or command palette, never raw disable/enable or Cmd+R), commit discipline, source layout, known constraints (PTY/Python, xterm CSS inline, tilde expansion, Node builtins via window.require, resize protocol), plugin output path

## 7. Verification

- [ ] 7.1 Run `npm run build` and confirm clean build with no errors
- [ ] 7.2 Enable the `work-terminal` plugin in Obsidian and verify it appears in the plugin list
- [ ] 7.3 Open the Work Terminal view and verify the split layout renders with an interactive xterm.js terminal in the right panel
- [ ] 7.4 Run `npm run dev`, make a trivial source change, and verify CDP hot-reload triggers in Obsidian
- [ ] 7.5 Commit all files and push to `github.com/tomcorke/obsidian-work-terminal`
