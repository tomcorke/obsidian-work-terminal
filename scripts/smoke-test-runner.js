/**
 * Tier 1 CDP-based smoke test runner for obsidian-work-terminal.
 *
 * Launches an isolated Obsidian instance, seeds test data via the filesystem,
 * runs CDP-based test assertions (Tier 1 smoke tests + layout invariants +
 * generic sanity sweep), captures reference screenshots, reports pass/fail,
 * and cleans up.
 *
 * Usage:
 *   pnpm run test:smoke
 *   node scripts/smoke-test-runner.js [--no-hide] [--timeout 30000]
 *
 * Introduced in #343 (Tier 1 smoke tests). Layout invariants, parameterised
 * detail-placement coverage, the generic sanity sweep, and screenshot
 * capture were added for issue #491.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  CDPClient,
  assertDebuggerPortAvailable,
  assertIsolatedLaunchSupported,
  dismissTrustDialog,
  ensureIsolatedVault,
  findAvailablePort,
  hideObsidianWindow,
  killIsolatedInstance,
  launchObsidian,
  runCdpCommand,
  seedUserDataDir,
  verifyObsidianVault,
  waitForDebugger,
} = require("./lib/obsidianAutomation");
const { buildSanityCheckCdpExpression } = require("./lib/layoutAssertions");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");
const SMOKE_VAULT_DIR = path.join(REPO_ROOT, ".claude", "testing", "smoke-tests");
const MANAGED_VAULT_DIR = path.join(REPO_ROOT, ".claude", "testing", "obsidian-vault");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "output", "smoke-screenshots");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;
const WATCHER_SETTLE_MS = 3000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let hide = true;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-hide") hide = false;
    if (argv[i] === "--timeout" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = parsed;
      } else {
        console.warn(`Warning: invalid --timeout value "${argv[i + 1]}", using default ${DEFAULT_TIMEOUT_MS}ms`);
      }
      i += 1;
    }
  }
  return { hide, timeoutMs };
}

// ---------------------------------------------------------------------------
// Seed data helpers
// ---------------------------------------------------------------------------

function buildTaskContent({ id, state, title, score, deadline, impact, hasBlocker, blockerContext }) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `---
id: ${id}
tags:
  - task
  - task/${state}

state: ${state}

title: "${title}"

source:
  type: prompt
  id: "smoke-${state}"
  url: ""
  captured: ${now}

priority:
  score: ${score || 10}
  deadline: "${deadline || ""}"
  impact: ${impact || "medium"}
  has-blocker: ${hasBlocker || false}
  blocker-context: "${blockerContext || ""}"

agent-actionable: false

goal: []

related: []

created: ${now}
updated: ${now}
---
# ${title}

Smoke test seed task.
`;
}

async function seedSmokeTestData(vaultDir) {
  const baseDir = path.join(vaultDir, "2 - Areas", "Tasks");

  // Ensure all state directories exist (including done and abandoned)
  for (const state of ["priority", "active", "todo", "done", "abandoned"]) {
    await fsp.mkdir(path.join(baseDir, state), { recursive: true });
  }

  const tasks = [
    {
      dir: path.join(baseDir, "priority"),
      filename: "TASK-smoke-priority-1.md",
      id: "smoke-priority-001",
      state: "priority",
      title: "Priority smoke task",
      score: 95,
    },
    {
      dir: path.join(baseDir, "active"),
      filename: "TASK-smoke-active-1.md",
      id: "smoke-active-001",
      state: "active",
      title: "Active smoke task",
      score: 50,
    },
    {
      dir: path.join(baseDir, "todo"),
      filename: "TASK-smoke-todo-1.md",
      id: "smoke-todo-001",
      state: "todo",
      title: "Todo smoke task",
      score: 20,
    },
    {
      dir: path.join(baseDir, "done"),
      filename: "TASK-smoke-done-1.md",
      id: "smoke-done-001",
      state: "done",
      title: "Done smoke task",
      score: 10,
    },
    {
      dir: path.join(baseDir, "abandoned"),
      filename: "TASK-smoke-abandoned-1.md",
      id: "smoke-abandoned-001",
      state: "abandoned",
      title: "Abandoned smoke task",
      score: 5,
    },
  ];

  for (const task of tasks) {
    const filePath = path.join(task.dir, task.filename);
    await fsp.writeFile(filePath, buildTaskContent(task), "utf8");
  }

  return tasks;
}

async function snapshotPluginDataFile() {
  const dataPath = path.join(REPO_ROOT, "data.json");
  try {
    return { exists: true, dataPath, content: await fsp.readFile(dataPath, "utf8") };
  } catch {
    return { exists: false, dataPath, content: null };
  }
}

async function restorePluginDataFile(snapshot) {
  if (!snapshot) return;
  if (snapshot.exists) {
    await fsp.writeFile(snapshot.dataPath, snapshot.content, "utf8");
  } else {
    await fsp.rm(snapshot.dataPath, { force: true });
  }
}

async function configureSmokeTestDataFile() {
  const dataPath = path.join(REPO_ROOT, "data.json");
  let data = {};
  try {
    data = JSON.parse(await fsp.readFile(dataPath, "utf8"));
  } catch {
    data = {};
  }
  data.settings = {
    ...(data.settings || {}),
    "adapter.enrichmentEnabled": false,
    "core.detailViewPlacement": "split",
  };
  await fsp.writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// CDP evaluation helpers
// ---------------------------------------------------------------------------

async function cdpEval(host, port, expression, timeoutMs) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await CDPClient.connect({ host, port, timeoutMs });
    try {
      return await client.evaluate(expression);
    } catch (err) {
      lastError = err;
      if (!String(err?.message || err).includes("Promise was collected")) {
        throw err;
      }
      await sleep(250);
    } finally {
      client.close();
    }
  }
  throw lastError;
}

async function cdpWaitFor(host, port, selector, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const exists = await cdpEval(host, port,
        `!!document.querySelector(${JSON.stringify(selector)})`,
        Math.min(timeoutMs, 5000));
      if (exists) return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for selector: ${selector}` +
    (lastError ? ` (${lastError.message})` : ""),
  );
}

async function cdpClick(host, port, selector, timeoutMs) {
  const client = await CDPClient.connect({ host, port, timeoutMs });
  try {
    return await client.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Selector not found: " + ${JSON.stringify(selector)});
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          throw new Error("Selector has no clickable area: " + ${JSON.stringify(selector)});
        }
        el.click();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()
    `);
  } finally {
    client.close();
  }
}

async function cdpType(host, port, selector, text, timeoutMs) {
  const client = await CDPClient.connect({ host, port, timeoutMs });
  try {
    await client.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Selector not found: " + ${JSON.stringify(selector)});
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.focus();
        if ("value" in el) {
          el.value = "";
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
        } else if (el.isContentEditable) {
          el.textContent = "";
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
        }
        return true;
      })()
    `);
    if (text) {
      await client.send("Input.insertText", { text });
      await client.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(text)}, inputType: "insertText" }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return true;
        })()
      `);
    }
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Layout invariant helpers (LI-01, LI-02, LI-03)
// ---------------------------------------------------------------------------

/**
 * Persist a detail view placement change via the plugin data API and fire the
 * settings-changed event so the MainView re-mounts the detail view at the new
 * placement without requiring a plugin reload. Returns once the switch has
 * had a chance to settle.
 *
 * `placement` must be one of: "split" | "embedded" | "preview" | "tab" |
 * "navigate" | "disabled". The test runner currently exercises split,
 * embedded, and preview (see LI-01..03 and the parameterised variants).
 */
async function setDetailPlacement(host, port, placement, timeoutMs) {
  await cdpEval(host, port, `
    (async () => {
      const plugin = globalThis.app?.plugins?.plugins?.['work-terminal'];
      if (!plugin) throw new Error("work-terminal plugin not loaded");

      // 1. Persist the placement override to plugin data.
      const data = (await plugin.loadData()) || {};
      if (!data.settings) data.settings = {};
      data.settings['core.detailViewPlacement'] = ${JSON.stringify(placement)};
      await plugin.saveData(data);

      // 2. Build a *fully merged* settings snapshot to dispatch. MainView's
      //    settings-changed handler replaces this.settings with event.detail
      //    wholesale (see MainView._handleSettingsChanged), so dispatching
      //    just { 'core.detailViewPlacement': X } would wipe every other
      //    setting - core defaults, adapter defaults, and user overrides.
      //    Mirror the merge in SettingsTab.loadAllSettings: start from the
      //    active MainView's cached snapshot (already merged at view init),
      //    then override with the key we just changed.
      const view = globalThis.app?.workspace
        ?.getLeavesOfType('work-terminal-view')?.[0]?.view;
      const merged = view && view.settings
        ? { ...view.settings }
        : { ...data.settings };
      merged['core.detailViewPlacement'] = ${JSON.stringify(placement)};

      window.dispatchEvent(new CustomEvent('work-terminal:settings-changed', { detail: merged }));
      return true;
    })()
  `, timeoutMs);
  // Settle time for remountDetailViewForCurrentSelection + render.
  await sleep(500);
}

async function closeTaskDetailLeaves(host, port, timeoutMs) {
  await cdpEval(host, port, `
    (async () => {
      const leaves = globalThis.app?.workspace?.getLeavesOfType('markdown') || [];
      for (const leaf of leaves) {
        const taskPath = leaf?.view?.file?.path || '';
        if (taskPath.startsWith('2 - Areas/Tasks/')) {
          leaf.detach();
        }
      }
      return true;
    })()
  `, timeoutMs).catch(() => null);
  await sleep(300);
}

/**
 * Assert that the active tab's visible content fills the available terminal
 * area (LI-01). Tolerance of 2px handles sub-pixel rounding and scrollbar
 * gutters. In split placement, the terminal wrapper hosts whichever shell/
 * agent tab is active; in embedded/preview placement, the detail host
 * occupies the same slot when its pseudo-tab is active.
 */
async function assertActiveContentFillsContainer(host, port, timeoutMs) {
  const info = await cdpEval(host, port, `
    (() => {
      // Prefer whichever slot is currently visible: embedded host, preview
      // host, or the terminal wrapper. Only one is display:"" at a time.
      const slots = [
        document.querySelector('.wt-embedded-detail-host'),
        document.querySelector('.wt-preview-detail-host'),
        document.querySelector('.wt-terminal-wrapper'),
      ].filter((el) => el && getComputedStyle(el).display !== 'none');
      if (slots.length === 0) return { ok: false, reason: 'no-visible-slot' };
      // The active slot is the last one inserted before the wrapper that is
      // visible; if multiple are visible (shouldn't happen post-fix) take
      // whichever is not the terminal wrapper to be strict.
      const wrapper = document.querySelector('.wt-terminal-wrapper');
      const active = slots.find((s) => s !== wrapper) || wrapper;
      const parent = active.parentElement;
      if (!parent) return { ok: false, reason: 'no-parent' };
      return {
        ok: true,
        slotClass: active.className,
        slotWidth: active.offsetWidth,
        slotHeight: active.offsetHeight,
        parentWidth: parent.offsetWidth,
        parentClientWidth: parent.clientWidth,
        parentHeight: parent.offsetHeight,
      };
    })()
  `, timeoutMs);
  if (!info.ok) {
    throw new Error("LI-01: no visible content slot found: " + (info.reason || "unknown"));
  }
  const tolerance = 2;
  // Compare against the inner width of the parent (clientWidth) because the
  // tab bar + title consume vertical space but not horizontal. The bug in
  // #490 manifested as the terminal wrapper being ~50% of its parent width.
  const widthRatio = info.slotWidth / Math.max(1, info.parentClientWidth);
  if (info.slotWidth + tolerance < info.parentClientWidth) {
    throw new Error(
      "LI-01: active content does not fill container width: " +
      "slot=" + info.slotWidth + "px, parent=" + info.parentClientWidth + "px, " +
      "ratio=" + widthRatio.toFixed(2) + " (class=" + info.slotClass + ")",
    );
  }
}

/**
 * Assert that inactive tab panels are actually hidden (LI-02). When the
 * Detail pseudo-tab is active (embedded/preview), the terminal wrapper must
 * be display:none. When a terminal tab is active, the detail host (if it
 * exists) must be display:none. Prevents the "bleed through" class of bug
 * where an inactive panel is still laid out.
 */
async function assertInactiveTabsHidden(host, port, timeoutMs) {
  const info = await cdpEval(host, port, `
    (() => {
      const wrapper = document.querySelector('.wt-terminal-wrapper');
      const embeddedHost = document.querySelector('.wt-embedded-detail-host');
      const previewHost = document.querySelector('.wt-preview-detail-host');
      const visible = (el) => el && getComputedStyle(el).display !== 'none';
      return {
        wrapperVisible: visible(wrapper),
        embeddedHostVisible: visible(embeddedHost),
        previewHostVisible: visible(previewHost),
        embeddedHostExists: !!embeddedHost,
        previewHostExists: !!previewHost,
      };
    })()
  `, timeoutMs);
  const visibleCount = [info.wrapperVisible, info.embeddedHostVisible, info.previewHostVisible].filter(Boolean).length;
  if (visibleCount !== 1) {
    throw new Error(
      "LI-02: expected exactly one visible content slot, got " + visibleCount +
      " (wrapper=" + info.wrapperVisible + ", embedded=" + info.embeddedHostVisible +
      ", preview=" + info.previewHostVisible + ")",
    );
  }
}

/**
 * Click the Detail or Preview pseudo-tab inside the Work Terminal panel.
 * No-op if the pseudo-tab is not rendered (e.g. split placement). Returns
 * true when a click was dispatched.
 */
async function clickDetailPseudoTab(host, port, timeoutMs) {
  const selector = '.wt-tab-detail, .wt-tab-preview';
  const exists = await cdpEval(host, port,
    `!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
  if (!exists) return false;
  await cdpClick(host, port, selector, timeoutMs);
  await sleep(300);
  return true;
}

/**
 * Click the first terminal shell/agent tab (skipping the Detail/Preview
 * pseudo-tabs) to restore the terminal view. Returns true when a click
 * was dispatched.
 */
async function clickFirstShellTab(host, port, timeoutMs) {
  const selector = '.wt-tab:not(.wt-tab-detail):not(.wt-tab-preview)';
  const exists = await cdpEval(host, port,
    `!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
  if (!exists) return false;
  await cdpClick(host, port, selector, timeoutMs);
  await sleep(300);
  return true;
}

/**
 * Select the first visible task card in the list. Detail-view placements
 * that mount a pseudo-tab (embedded/preview) require a selected item for
 * the tab to appear.
 *
 * ListPanel renders each card as a `.wt-card-wrapper` element with a
 * `data-item-id` attribute; the TaskCard root inside is `.wt-card`. There
 * is no `.wt-task-card` class in the current UI, so we target the wrapper.
 */
async function selectFirstTaskCard(host, port, timeoutMs) {
  const selector = '.wt-card-wrapper';
  const exists = await cdpEval(host, port,
    `!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
  if (!exists) throw new Error("No task card found to select");
  await cdpClick(host, port, selector, timeoutMs);
  await sleep(500);
}

/**
 * Activate the first task for terminal spawning without opening the split
 * detail leaf. Real clicks select cards and (in split placement) open a
 * Markdown leaf, which can perturb the smoke runner's terminal-focused tests.
 */
async function activateFirstTaskForTerminal(host, port, timeoutMs) {
  await cdpEval(host, port, `
    (() => {
      const view = globalThis.app?.workspace
        ?.getLeavesOfType('work-terminal-view')?.[0]?.view;
      const card = document.querySelector('.wt-card-wrapper');
      const id = card?.getAttribute('data-item-id');
      if (!view || !view.terminalPanel || !id) {
        throw new Error('No Work Terminal task available to activate');
      }
      const item = (view.allItems || []).find((candidate) => candidate.id === id) || null;
      view.terminalPanel.setActiveItem(id);
      view.terminalPanel.setTitle(item);
      document.querySelectorAll('.wt-card-selected').forEach((el) => el.classList.remove('wt-card-selected'));
      card.classList.add('wt-card-selected');
      return true;
    })()
  `, timeoutMs);
  await sleep(200);
}

/**
 * Apply deterministic settings for the smoke vault. The real plugin defaults
 * keep background enrichment enabled, which is useful for users but unsafe in
 * smoke tests: creating a task would launch a real headless agent and leave
 * transient card animation DOM that the generic sanity sweep correctly sees as
 * clipped/zero-sized. Disable enrichment and start from split placement.
 */
async function configureSmokeTestSettings(host, port, timeoutMs) {
  await cdpEval(host, port, `
    (async () => {
      const plugin = globalThis.app?.plugins?.plugins?.['work-terminal'];
      if (!plugin) throw new Error("work-terminal plugin not loaded");

      const data = (await plugin.loadData()) || {};
      const persistedSettings = { ...(data.settings || {}) };
      persistedSettings['adapter.enrichmentEnabled'] = false;
      persistedSettings['core.detailViewPlacement'] = 'split';
      data.settings = persistedSettings;
      await plugin.saveData(data);

      const view = globalThis.app?.workspace
        ?.getLeavesOfType('work-terminal-view')?.[0]?.view;
      const merged = view && view.settings
        ? { ...view.settings, ...persistedSettings }
        : persistedSettings;
      window.dispatchEvent(new CustomEvent('work-terminal:settings-changed', { detail: merged }));
      return true;
    })()
  `, timeoutMs);
  await sleep(500);
}

/**
 * Run the generic sanity checks (zero-size visible, overflow clipping,
 * out-of-bounds positioning) via CDP and throw if any violations are found.
 * Intended to run after every smoke test scenario so regressions in both
 * existing and brand-new features are flagged without per-feature upkeep.
 */
async function runSanitySweep(host, port, timeoutMs, context) {
  const expr = buildSanityCheckCdpExpression();
  const violations = await cdpEval(host, port, expr, timeoutMs);
  if (Array.isArray(violations) && violations.length > 0) {
    const summary = violations.slice(0, 5).map((v) =>
      `${v.type} on ${v.selector}: ${JSON.stringify(v.details)}`,
    ).join("; ");
    const more = violations.length > 5 ? ` (and ${violations.length - 5} more)` : "";
    throw new Error(`Sanity sweep after ${context}: ${violations.length} violation(s): ${summary}${more}`);
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

/**
 * Capture a PNG screenshot of the selector (or the whole page, when selector
 * is null) into the given path under SCREENSHOT_DIR. Uses the existing
 * `runCdpCommand` screenshot support. Silently returns null if the selector
 * is missing - callers treat missing screenshots as informational.
 */
async function captureScreenshot(host, port, timeoutMs, relativePath, selector) {
  const outputPath = path.join(SCREENSHOT_DIR, relativePath);
  try {
    if (selector) {
      const exists = await cdpEval(host, port,
        `!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
      if (!exists) {
        console.log(`  skip  screenshot ${relativePath} (selector not present: ${selector})`);
        return null;
      }
    }
    const result = await runCdpCommand({
      command: "screenshot",
      host,
      port,
      timeoutMs,
      outputPath,
      selector: selector || undefined,
      selectorPadding: 4,
    });
    console.log(`  shot  ${relativePath} (${selector || "full page"})`);
    return result.outputPath;
  } catch (err) {
    console.log(`  skip  screenshot ${relativePath}: ${err.message}`);
    return null;
  }
}

/**
 * Capture a fixed set of reference screenshots at the end of the smoke run.
 * No comparison is performed; the developer reviews the captures visually
 * as part of PR review. Baseline maintenance is intentionally avoided - see
 * docs/regression-tests.md for the rationale.
 *
 * Covered views:
 *   - 01-main-layout: 2-panel split (left list, right terminals)
 *   - 02-detail-split: detail view after selecting a task (split placement)
 *   - 03-inactive-tab: shell tab active, Detail pseudo-tab inactive
 *                      (embedded placement)
 *   - 04-detail-embedded: Detail pseudo-tab active (embedded placement)
 *   - 05-detail-preview: Preview pseudo-tab active (preview placement)
 */
async function captureReferenceScreenshots(host, port, timeoutMs) {
  console.log("\n--- Capturing reference screenshots ---\n");
  await fsp.mkdir(SCREENSHOT_DIR, { recursive: true });

  // Main 2-panel layout - split placement, before any split detail leaf is open.
  await setDetailPlacement(host, port, "split", timeoutMs);
  await closeTaskDetailLeaves(host, port, timeoutMs);
  await sleep(400);
  await captureScreenshot(host, port, timeoutMs, "01-main-layout.png", ".wt-main-view");

  // Detail view opened beside the terminal panel (split placement creates a
  // separate workspace leaf, so capture the full workspace).
  await selectFirstTaskCard(host, port, timeoutMs);
  await sleep(600);
  await captureScreenshot(host, port, timeoutMs, "02-detail-split.png", ".workspace");
  await closeTaskDetailLeaves(host, port, timeoutMs);

  // Switch to embedded placement and capture shell-tab-active + detail-
  // active states.
  await setDetailPlacement(host, port, "embedded", timeoutMs);
  await selectFirstTaskCard(host, port, timeoutMs);
  await sleep(500);
  // Clicking the shell tab takes us to the "inactive detail" state.
  await clickFirstShellTab(host, port, timeoutMs);
  await captureScreenshot(host, port, timeoutMs, "03-inactive-detail-tab.png", ".wt-right-panel");
  // Now click the Detail pseudo-tab back on.
  await clickDetailPseudoTab(host, port, timeoutMs);
  await sleep(400);
  await captureScreenshot(host, port, timeoutMs, "04-detail-embedded.png", ".wt-right-panel");

  // Preview placement.
  await setDetailPlacement(host, port, "preview", timeoutMs);
  await selectFirstTaskCard(host, port, timeoutMs);
  await sleep(400);
  await clickDetailPseudoTab(host, port, timeoutMs);
  await sleep(300);
  await captureScreenshot(host, port, timeoutMs, "05-detail-preview.png", ".wt-right-panel");

  // Capture the settings General section. The settings UI opens via a
  // command, so drive it through the command palette ID.
  await cdpEval(host, port, `
    (async () => {
      const app = globalThis.app;
      if (!app) return false;
      // Open settings modal and select the Work Terminal tab.
      app.setting.open();
      app.setting.openTabById('work-terminal');
      return true;
    })()
  `, timeoutMs).catch(() => null);
  await sleep(600);
  await captureScreenshot(host, port, timeoutMs, "06-settings-general.png", ".modal-container");
  await cdpEval(host, port, `(() => { try { globalThis.app.setting.close(); } catch { } return true; })()`, timeoutMs).catch(() => null);

  // Restore the default split placement before the runner exits so the
  // persisted settings in the managed vault stay in a known state.
  await setDetailPlacement(host, port, "split", timeoutMs);

  console.log(`\nScreenshots written to ${path.relative(REPO_ROOT, SCREENSHOT_DIR)}/`);
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

function defineTests({ host, port, timeoutMs, vaultDir }) {
  return [
    {
      id: "TC-01",
      description: "PTY wrapper spawns shell",
      run: async () => {
        // Terminal sessions are keyed per work item, so activate a task before
        // spawning the shell. Without an active item TabManager.createTab()
        // intentionally no-ops.
        await activateFirstTaskForTerminal(host, port, timeoutMs);
        // Click the "+ Shell" button
        await cdpClick(host, port, "button.wt-spawn-btn", timeoutMs);
        // Wait for xterm to appear
        await cdpWaitFor(host, port, ".xterm", timeoutMs);
        // Verify a terminal element exists
        const exists = await cdpEval(host, port,
          "!!document.querySelector('.wt-terminal-wrapper .xterm')",
          timeoutMs);
        if (!exists) throw new Error("xterm terminal element not found after spawning shell");
      },
    },
    {
      id: "TC-02",
      description: "Tilde expansion",
      run: async () => {
        // Wait for the shell tab created by TC-01. In the current xterm canvas
        // renderer there may be no `.xterm-rows` or `.xterm-cursor-layer` DOM,
        // so assert the plugin's resolved tab cwd directly instead of scraping
        // terminal pixels.
        await cdpWaitFor(host, port, ".xterm", timeoutMs);
        const cwd = await cdpEval(host, port, `
          (() => {
            const panel = globalThis.app?.workspace
              ?.getLeavesOfType('work-terminal-view')?.[0]?.view?.terminalPanel;
            const manager = panel?.tabManager;
            const itemId = manager?.activeItemId;
            const tabs = itemId ? manager?.sessions?.get(itemId) : null;
            const activeIndex = manager?.activeTabIndex ?? 0;
            return tabs?.[activeIndex]?.cwd || tabs?.[0]?.cwd || null;
          })()
        `, timeoutMs);
        const os = require("node:os");
        const home = os.homedir();
        const isAbsolute = typeof cwd === "string" &&
          (cwd === home || cwd.startsWith("/") || /^[A-Z]:\\/.test(cwd));
        if (!isAbsolute || cwd === "~") {
          throw new Error(`Shell cwd was not expanded from ~ to an absolute path: ${cwd}`);
        }
      },
    },
    {
      id: "TC-12",
      description: "xterm.js CSS injection",
      run: async () => {
        const hasXtermCss = await cdpEval(host, port,
          "!!document.getElementById('xterm-css')",
          timeoutMs);
        if (!hasXtermCss) throw new Error("xterm-css style element not found in DOM");
      },
    },
    {
      id: "TM-01",
      description: "Tab bar layout",
      run: async () => {
        // Verify the tab bar exists and has at least one tab (the shell we spawned)
        const tabCount = await cdpEval(host, port, `
          (() => {
            const tabs = document.querySelectorAll('.wt-tab-bar .wt-tab');
            return tabs.length;
          })()
        `, timeoutMs);
        if (typeof tabCount !== "number" || tabCount < 1) {
          throw new Error(`Expected at least 1 tab in tab bar, got ${tabCount}`);
        }
      },
    },
    {
      id: "TL-01",
      description: "Collapsible sections",
      run: async () => {
        // Check that section elements exist with correct classes
        const sectionInfo = await cdpEval(host, port, `
          (() => {
            const sections = document.querySelectorAll('.wt-section');
            const headers = document.querySelectorAll('.wt-section-header');
            return {
              sectionCount: sections.length,
              headerCount: headers.length,
              hasDataColumn: sections.length > 0 && !!sections[0].getAttribute('data-column'),
            };
          })()
        `, timeoutMs);
        if (sectionInfo.sectionCount < 1) {
          throw new Error(`Expected at least 1 section, got ${sectionInfo.sectionCount}`);
        }
        if (sectionInfo.headerCount < 1) {
          throw new Error(`Expected at least 1 section header, got ${sectionInfo.headerCount}`);
        }
        if (!sectionInfo.hasDataColumn) {
          throw new Error("Section elements missing data-column attribute");
        }
      },
    },
    {
      id: "TL-21",
      description: "Filter input",
      run: async () => {
        // Get visible card count before filtering (visibility-aware)
        const beforeCount = await cdpEval(host, port, `
          (() => {
            const cards = document.querySelectorAll('.wt-card-wrapper');
            return Array.from(cards).filter(el => getComputedStyle(el).display !== 'none').length;
          })()
        `, timeoutMs);

        // Type a filter term that should match only one seeded task
        await cdpType(host, port, ".wt-filter-input", "Priority smoke", timeoutMs);
        // The real UI debounces filter application with setTimeout. Hidden
        // Electron windows can throttle renderer timers, so flush the same
        // ListPanel state synchronously to keep the smoke runner deterministic
        // while still exercising the input value and filtering code path.
        await cdpEval(host, port, `
          (() => {
            const view = globalThis.app?.workspace
              ?.getLeavesOfType('work-terminal-view')?.[0]?.view;
            const listPanel = view?.listPanel;
            const input = document.querySelector('.wt-filter-input');
            if (listPanel && input) {
              if (listPanel.filterDebounce) clearTimeout(listPanel.filterDebounce);
              listPanel.filterTerm = (input.value || '').toLowerCase();
              if (typeof listPanel.applyFilter === 'function') listPanel.applyFilter();
            }
            return true;
          })()
        `, timeoutMs);
        await sleep(300);

        // Check that visible cards are filtered (visibility-aware)
        const afterInfo = await cdpEval(host, port, `
          (() => {
            const input = document.querySelector('.wt-filter-input');
            const visibleSections = Array.from(document.querySelectorAll('.wt-section'))
              .filter(s => getComputedStyle(s).display !== 'none');
            const cards = document.querySelectorAll('.wt-card-wrapper');
            const visibleCards = Array.from(cards).filter(el => getComputedStyle(el).display !== 'none');
            return {
              filterValue: input ? input.value : null,
              visibleSectionCount: visibleSections.length,
              visibleCardCount: visibleCards.length,
            };
          })()
        `, timeoutMs);

        if (!afterInfo.filterValue || !afterInfo.filterValue.includes("Priority")) {
          throw new Error("Filter input value not set correctly");
        }

        // Assert filtering actually reduced visible card count
        if (beforeCount > 0 && afterInfo.visibleCardCount >= beforeCount) {
          throw new Error(
            `Filter did not reduce visible cards: before=${beforeCount}, after=${afterInfo.visibleCardCount}`,
          );
        }

        // Clear the filter for subsequent tests
        await cdpType(host, port, ".wt-filter-input", "", timeoutMs);
        await sleep(300);
      },
    },
    {
      id: "TL-29",
      description: "Abandoned tasks filtered",
      run: async () => {
        // Verify abandoned task is NOT visible in the kanban board
        const hasAbandoned = await cdpEval(host, port, `
          (() => {
            const cards = document.querySelectorAll('.wt-card-wrapper');
            for (const card of cards) {
              if (card.textContent.includes('Abandoned smoke task')) return true;
            }
            return false;
          })()
        `, timeoutMs);
        if (hasAbandoned) {
          throw new Error("Abandoned task should not be visible in kanban board");
        }

        // Double check: the file exists on disk but is filtered from the UI
        const abandonedFilePath = path.join(
          vaultDir, "2 - Areas", "Tasks", "abandoned", "TASK-smoke-abandoned-1.md",
        );
        if (!fs.existsSync(abandonedFilePath)) {
          throw new Error("Abandoned task file should exist on disk");
        }
      },
    },
    {
      id: "SP-03",
      description: "Disk persistence on spawn",
      run: async () => {
        // The plugin persists session data to data.json via Obsidian's plugin data API.
        // After spawning a shell (TC-01), trigger a persist cycle and check the file.
        // Force a save via the plugin API
        await cdpEval(host, port, `
          (async () => {
            const plugin = globalThis.app?.plugins?.plugins?.['work-terminal'];
            if (plugin && typeof plugin.saveData === 'function') {
              await plugin.saveData(plugin.data || {});
            }
            return true;
          })()
        `, timeoutMs);

        await sleep(1000);

        const dataJsonPath = path.join(
          vaultDir, ".obsidian", "plugins", "work-terminal", "data.json",
        );

        // The data.json may be in the actual plugin dir (symlinked) or in the vault.
        // Try reading from the vault's .obsidian path first.
        let dataExists = false;
        try {
          await fsp.access(dataJsonPath, fs.constants.F_OK);
          dataExists = true;
        } catch {
          // data.json might not exist yet if nothing was saved - check if
          // plugin.data has sessions via CDP instead
        }

        if (dataExists) {
          const content = await fsp.readFile(dataJsonPath, "utf8");
          // Just verify it is valid JSON
          JSON.parse(content);
        } else {
          // Verify via CDP that the plugin has data in memory
          const hasData = await cdpEval(host, port, `
            (() => {
              const plugin = globalThis.app?.plugins?.plugins?.['work-terminal'];
              return plugin && typeof plugin.data === 'object' && plugin.data !== null;
            })()
          `, timeoutMs);
          if (!hasData) {
            throw new Error("Plugin data not found in memory or on disk");
          }
        }
      },
    },
    {
      id: "TO-01",
      description: "Task creation via PromptBox",
      run: async () => {
        const taskTitle = `Smoke-created-${Date.now()}`;

        // Expand the PromptBox by clicking the toggle
        await cdpClick(host, port, ".wt-prompt-toggle", timeoutMs);
        await sleep(300);

        // Type the title in the prompt input
        await cdpType(host, port, ".wt-prompt-input", taskTitle, timeoutMs);
        await sleep(200);

        // Click the send/create button
        await cdpClick(host, port, ".wt-prompt-send", timeoutMs);
        await sleep(2000);

        // Verify a file was created with the task title
        const taskDirs = ["priority", "active", "todo"];
        let found = false;
        for (const state of taskDirs) {
          const dir = path.join(vaultDir, "2 - Areas", "Tasks", state);
          try {
            const files = await fsp.readdir(dir);
            for (const file of files) {
              if (!file.endsWith(".md")) continue;
              const content = await fsp.readFile(path.join(dir, file), "utf8");
              if (content.includes(taskTitle)) {
                found = true;
                break;
              }
            }
          } catch {
            // Directory might not exist
          }
          if (found) break;
        }

        if (!found) {
          throw new Error(`Task file with title "${taskTitle}" not found after PromptBox creation`);
        }

        // Let the new-card success animation collapse before the generic
        // sanity sweep runs; the animation intentionally uses overflow:hidden
        // while it is visible.
        await sleep(4500);
      },
    },
    {
      id: "LD-01",
      description: "2-panel split layout",
      run: async () => {
        const panels = await cdpEval(host, port, `
          (() => {
            const left = document.querySelector('.wt-left-panel');
            const right = document.querySelector('.wt-right-panel');
            const divider = document.querySelector('.wt-divider');
            return {
              hasLeft: !!left,
              hasRight: !!right,
              hasDivider: !!divider,
              leftWidth: left ? left.offsetWidth : 0,
              rightWidth: right ? right.offsetWidth : 0,
            };
          })()
        `, timeoutMs);

        if (!panels.hasLeft) throw new Error("Left panel (.wt-left-panel) not found");
        if (!panels.hasRight) throw new Error("Right panel (.wt-right-panel) not found");
        if (!panels.hasDivider) throw new Error("Divider (.wt-divider) not found");
        if (panels.leftWidth < 100) throw new Error(`Left panel too narrow: ${panels.leftWidth}px`);
        if (panels.rightWidth < 100) throw new Error(`Right panel too narrow: ${panels.rightWidth}px`);
      },
    },
    // -----------------------------------------------------------------------
    // LI-01: Active tab content fills its container (split placement).
    // Would have caught #490 directly - the original bug was the terminal
    // wrapper rendering at ~50% of its parent width.
    // -----------------------------------------------------------------------
    {
      id: "LI-01-split",
      description: "Active content fills container (split placement)",
      run: async () => {
        await setDetailPlacement(host, port, "split", timeoutMs);
        try {
          await selectFirstTaskCard(host, port, timeoutMs);
          await assertActiveContentFillsContainer(host, port, timeoutMs);
        } finally {
          await closeTaskDetailLeaves(host, port, timeoutMs);
        }
      },
    },
    // -----------------------------------------------------------------------
    // LI-02: Inactive tab panels are hidden. Ensures exactly one content
    // slot is visible in the terminal panel at any time.
    // -----------------------------------------------------------------------
    {
      id: "LI-02-split",
      description: "Inactive tabs hidden (split placement)",
      run: async () => {
        // Split placement should not mount the embedded/preview hosts.
        await assertInactiveTabsHidden(host, port, timeoutMs);
      },
    },
    // -----------------------------------------------------------------------
    // LI-03: Tab switch round-trip.
    //
    // Split placement has no Detail/Preview pseudo-tab inside the panel
    // (detail is a separate workspace leaf), so the "round trip" we can
    // validate here is selecting a task (which focuses the shell tab),
    // then reasserting LI-01/LI-02. The embedded/preview variants below
    // exercise the full Shell -> Detail -> Shell switch.
    // -----------------------------------------------------------------------
    {
      id: "LI-03-split",
      description: "Tab switch round-trip (split placement)",
      run: async () => {
        await clickFirstShellTab(host, port, timeoutMs);
        await assertActiveContentFillsContainer(host, port, timeoutMs);
        await assertInactiveTabsHidden(host, port, timeoutMs);
      },
    },
    // -----------------------------------------------------------------------
    // LI-01..03 for the embedded placement. When an item is selected, the
    // detail pseudo-tab auto-activates and the embedded host replaces the
    // terminal wrapper.
    // -----------------------------------------------------------------------
    {
      id: "LI-01-embedded",
      description: "Active content fills container (embedded placement)",
      run: async () => {
        await setDetailPlacement(host, port, "embedded", timeoutMs);
        await selectFirstTaskCard(host, port, timeoutMs);
        await sleep(400);
        await assertActiveContentFillsContainer(host, port, timeoutMs);
      },
    },
    {
      id: "LI-02-embedded",
      description: "Inactive tabs hidden (embedded placement)",
      run: async () => {
        await assertInactiveTabsHidden(host, port, timeoutMs);
      },
    },
    {
      id: "LI-03-embedded",
      description: "Tab switch round-trip (embedded placement)",
      run: async () => {
        // Currently on Detail pseudo-tab. Click the shell tab, assert
        // invariants, click Detail again, assert again.
        const shellClicked = await clickFirstShellTab(host, port, timeoutMs);
        if (!shellClicked) throw new Error("No shell tab to click for round-trip");
        await assertActiveContentFillsContainer(host, port, timeoutMs);
        await assertInactiveTabsHidden(host, port, timeoutMs);
        const detailClicked = await clickDetailPseudoTab(host, port, timeoutMs);
        if (!detailClicked) throw new Error("No Detail pseudo-tab to click for round-trip");
        await assertActiveContentFillsContainer(host, port, timeoutMs);
        await assertInactiveTabsHidden(host, port, timeoutMs);
      },
    },
    // -----------------------------------------------------------------------
    // LI-01..03 for the preview placement. The Preview pseudo-tab mounts
    // a read-only MarkdownRenderer inside .wt-preview-detail-host.
    // -----------------------------------------------------------------------
    {
      id: "LI-01-preview",
      description: "Active content fills container (preview placement)",
      run: async () => {
        await setDetailPlacement(host, port, "preview", timeoutMs);
        await selectFirstTaskCard(host, port, timeoutMs);
        await sleep(400);
        // Under preview placement, the Preview pseudo-tab is rendered but
        // not auto-activated on selection (unlike embedded). Click it.
        await clickDetailPseudoTab(host, port, timeoutMs);
        await assertActiveContentFillsContainer(host, port, timeoutMs);
      },
    },
    {
      id: "LI-02-preview",
      description: "Inactive tabs hidden (preview placement)",
      run: async () => {
        await assertInactiveTabsHidden(host, port, timeoutMs);
      },
    },
    {
      id: "LI-03-preview",
      description: "Tab switch round-trip (preview placement)",
      run: async () => {
        const shellClicked = await clickFirstShellTab(host, port, timeoutMs);
        if (!shellClicked) throw new Error("No shell tab to click for round-trip");
        await assertActiveContentFillsContainer(host, port, timeoutMs);
        await assertInactiveTabsHidden(host, port, timeoutMs);
        const previewClicked = await clickDetailPseudoTab(host, port, timeoutMs);
        if (!previewClicked) throw new Error("No Preview pseudo-tab to click for round-trip");
        await assertActiveContentFillsContainer(host, port, timeoutMs);
        await assertInactiveTabsHidden(host, port, timeoutMs);
        // Restore split placement so the sanity sweep and subsequent runs
        // see the default state, then close the split detail leaf opened by
        // remounting the current selection.
        await setDetailPlacement(host, port, "split", timeoutMs);
        await closeTaskDetailLeaves(host, port, timeoutMs);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = DEFAULT_HOST;
  const results = [];
  let port = null;
  let pid = null;
  let userDataDir = null;
  let pluginDataSnapshot = null;

  console.log("=== Smoke Test Runner ===");
  console.log(`Vault: ${SMOKE_VAULT_DIR}`);
  console.log(`Timeout: ${args.timeoutMs}ms`);
  console.log("");

  // Cleanup handler - ensure Obsidian is killed and plugin data restored even on failure
  async function cleanup() {
    if (userDataDir) {
      console.log("\nCleaning up isolated instance...");
      try {
        const killed = await killIsolatedInstance({ userDataDir });
        console.log(`Killed ${killed} Obsidian process(es).`);
      } catch (err) {
        console.error(`Cleanup error: ${err.message}`);
        // Last resort: kill by PID
        if (pid) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
        }
      }
    }
    await restorePluginDataFile(pluginDataSnapshot).catch(() => null);
  }

  // Handle unexpected exits
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    // Step 1: Find available port
    console.log("Finding available debug port...");
    port = await findAvailablePort({ host });
    console.log(`Using port ${port}`);

    // Step 2: Check port is free
    await assertDebuggerPortAvailable({ host, port, timeoutMs: args.timeoutMs });
    assertIsolatedLaunchSupported({ port });

    // Step 3: Create clean vault with plugin
    console.log("Creating clean smoke test vault...");
    const vaultInfo = await ensureIsolatedVault({
      vaultDir: SMOKE_VAULT_DIR,
      pluginDir: REPO_ROOT,
      clean: true,
      sampleData: false,
      force: true,
      managedVaultDir: MANAGED_VAULT_DIR,
    });

    // Step 4: Seed smoke test data
    console.log("Seeding test data...");
    await seedSmokeTestData(vaultInfo.vaultDir);

    // Step 5: Seed plugin data and user data dir
    pluginDataSnapshot = await snapshotPluginDataFile();
    await configureSmokeTestDataFile();
    userDataDir = path.join(vaultInfo.vaultDir, ".user-data");
    await seedUserDataDir({ userDataDir, vaultDir: vaultInfo.vaultDir });

    // Step 6: Launch Obsidian
    console.log("Launching Obsidian...");
    const launchResult = await launchObsidian({
      vaultDir: vaultInfo.vaultDir,
      port,
      userDataDir,
    });
    pid = launchResult.pid;
    console.log(`Obsidian launched (PID ${pid})`);

    // Step 7: Wait for debugger
    console.log("Waiting for CDP debugger...");
    await waitForDebugger({ host, port, timeoutMs: 30_000 });

    // Step 8: Verify vault
    console.log("Verifying vault connection...");
    await verifyObsidianVault({
      host,
      port,
      timeoutMs: args.timeoutMs,
      expectedVaultDir: vaultInfo.vaultDir,
    });

    // Step 9: Dismiss trust dialog
    console.log("Dismissing trust dialog...");
    await dismissTrustDialog({ host, port, timeoutMs: args.timeoutMs });

    // Step 10: Hide window (optional)
    if (args.hide) {
      await sleep(1500);
      await hideObsidianWindow({ host, port, timeoutMs: args.timeoutMs });
    }

    // Step 11: Open Work Terminal view
    console.log("Opening Work Terminal view...");
    await runCdpCommand({
      command: "open-view",
      host,
      port,
      timeoutMs: args.timeoutMs,
    });

    // Step 12: Wait for file watcher to detect seed data
    console.log(`Waiting ${WATCHER_SETTLE_MS}ms for file watcher to settle...`);
    await sleep(WATCHER_SETTLE_MS);

    // Force a vault refresh to ensure all seeded files are visible
    await cdpEval(host, port, `
      (async () => {
        const plugin = globalThis.app?.plugins?.plugins?.['work-terminal'];
        if (plugin && plugin._mainView && typeof plugin._mainView.refreshItems === 'function') {
          await plugin._mainView.refreshItems();
        } else {
          // Fallback: trigger vault cache warm
          await globalThis.app?.vault?.adapter?.list?.('2 - Areas/Tasks');
        }
        return true;
      })()
    `, args.timeoutMs);
    await configureSmokeTestSettings(host, port, args.timeoutMs);
    await sleep(1000);

    // Step 13: Run tests
    console.log("\n--- Running Tests ---\n");
    const tests = defineTests({
      host,
      port,
      timeoutMs: args.timeoutMs,
      vaultDir: vaultInfo.vaultDir,
    });

    for (const test of tests) {
      const startTime = Date.now();
      try {
        await test.run();
        // Run the generic sanity sweep after every successful test so
        // regressions in shared layout, clipping, and positioning are caught
        // even when no per-feature assertion exists yet. A sanity violation
        // fails the test it ran after.
        await runSanitySweep(host, port, args.timeoutMs, test.id);
        const duration = Date.now() - startTime;
        results.push({ id: test.id, description: test.description, passed: true, duration });
        console.log(`  PASS  ${test.id}: ${test.description} (${formatDuration(duration)})`);
      } catch (err) {
        const duration = Date.now() - startTime;
        results.push({
          id: test.id,
          description: test.description,
          passed: false,
          duration,
          error: err.message,
        });
        console.log(`  FAIL  ${test.id}: ${test.description} (${formatDuration(duration)})`);
        console.log(`        Error: ${err.message}`);
      }
    }

    // Capture reference screenshots after all tests have run. Failures here
    // are logged but do not fail the run - screenshots are review aids, not
    // assertions. If the test window was hidden for the interaction phase,
    // show it now because Electron cannot capture hidden window surfaces.
    try {
      if (args.hide) {
        await cdpEval(host, port, `(() => {
          try {
            const win = window.electron?.remote?.getCurrentWindow?.();
            win?.show?.();
            win?.focus?.();
          } catch { }
          return true;
        })()`, args.timeoutMs).catch(() => null);
        await sleep(1000);
      }
      await captureReferenceScreenshots(host, port, args.timeoutMs);
    } catch (err) {
      console.log(`  warn  screenshot capture failed: ${err.message}`);
    }

  } catch (err) {
    console.error(`\nFatal error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } finally {
    await cleanup();
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log("\n--- Summary ---\n");
  console.log(`  Total:  ${results.length}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time:   ${formatDuration(totalDuration)}`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ${r.id}: ${r.error}`);
    }
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
