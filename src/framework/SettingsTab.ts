/**
 * WorkTerminalSettingsTab - single settings UI combining core framework
 * settings with adapter-provided settings via namespaced keys.
 *
 * Structure (issue #462 reorganisation):
 *   1. General - base path, state resolution, view mode, recent threshold,
 *      card display mode, card indicator toggles, Jira base URL, guided tour
 *      reset, debug API, keepSessionsAlive, enrichmentLogging.
 *   2. Board & Columns - column order list + creation column list + custom
 *      card flag rules button (merges the old "Column Order & Creation" and
 *      "Card Indicators" sections).
 *   3. Terminal - "Configure terminal..." button opening a dedicated dialog
 *      (default shell, default terminal CWD).
 *   4. Detail view - placement dropdown + placement-dependent auto-close,
 *      width override, split direction controls. Unchanged.
 *   5. Agents - umbrella heading with Profile Manager, Background enrichment
 *      dialog button, Agent actions dialog button.
 *
 * The #462 reorganisation itself was a pure layout change - every moved
 * setting persisted under the same key it used before, so that work
 * introduced no schema change on its own. Subsequent Unreleased work (#472)
 * did remove the `core.additionalAgentContext` key as a breaking change;
 * see CHANGELOG.md "Removed" entry for details.
 *
 * ----------------------------------------------------------------------
 * Render-order invariant (issue #473)
 * ----------------------------------------------------------------------
 *
 * Settings MUST render in the exact order their `new Setting(containerEl)`
 * calls are issued from `display()`. No exceptions.
 *
 * To keep this invariant obvious and impossible to accidentally break:
 *
 *   - No private render helper calls `loadData()`; the render pass loads
 *     once via `display()` / `loadSnapshotAndRender()`, builds a
 *     `settings` snapshot, then passes that snapshot into every render
 *     helper synchronously.
 *
 *   - Every private render helper is SYNCHRONOUS and receives the
 *     pre-loaded `settings` object as a parameter. Helpers must not
 *     `await` anything between `new Setting()` calls - any await gives
 *     the microtask queue an opportunity to interleave another render's
 *     output into the middle of the current section.
 *
 *   - Change handlers attached to inputs are async (they call
 *     `saveSettings` + re-render), but they run in response to user
 *     input, not during the initial render pass, so they cannot reorder
 *     the DOM.
 *
 * The historical bug: a since-removed `renderAdditionalAgentContext`
 * helper awaited `loadData()` and then called `new Setting(containerEl)`
 * AFTER the Detail view section had rendered its first row synchronously
 * but was still awaiting further sub-renders. That setting's microtask
 * resolved mid-section and appended to `containerEl`, landing between
 * Placement and Auto-close. The fix enforced by this file is to pull ALL
 * `loadData` calls up into `display()` and make every helper pure and
 * sync.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import type {
  AdapterBundle,
  CardDisplayMode,
  CardFlagRule,
  SettingField,
} from "../core/interfaces";
import { mergeAndSavePluginData } from "../core/PluginDataStore";
import { resetGuidedTourStatus } from "./GuidedTour";
import type { AgentProfileManager } from "../core/agents/AgentProfileManager";
import { AgentProfileManagerModal } from "./AgentProfileManagerModal";
import { CardFlagManagerModal } from "./CardFlagManagerModal";
import { EnrichmentSettingsDialog } from "./EnrichmentSettingsDialog";
import { AgentActionsDialog } from "./AgentActionsDialog";
import { TerminalSettingsDialog } from "./TerminalSettingsDialog";
import { parseCardFlagRulesJson, serializeCardFlagRules } from "../core/cardFlags";
import type { ViewMode, RecentThreshold } from "./ActivityTracker";
import type { DetailViewPlacement, DetailViewSplitDirection } from "../core/detailViewPlacement";
import { resolveDetailViewOptions } from "../core/detailViewPlacement";
import { formatVersionForSettings } from "./version";

interface CoreSettings {
  "core.claudeCommand": string;
  "core.claudeExtraArgs": string;
  "core.copilotCommand": string;
  "core.copilotExtraArgs": string;
  "core.strandsCommand": string;
  "core.strandsExtraArgs": string;
  "core.defaultShell": string;
  "core.defaultTerminalCwd": string;
  "core.exposeDebugApi": boolean;
  "core.keepSessionsAlive": boolean;
  "core.enrichmentLogging": boolean;
  "core.cardDisplayMode": CardDisplayMode;
  "core.viewMode": ViewMode;
  "core.recentThreshold": RecentThreshold;
  "core.detailViewPlacement": DetailViewPlacement;
  "core.detailViewWidthOverride": boolean;
  "core.detailViewAutoClose": boolean;
  "core.detailViewSplitDirection": DetailViewSplitDirection;
  "core.showVersionInTabTitle": boolean;
}

export const SETTINGS_CHANGED_EVENT = "work-terminal:settings-changed";

/**
 * Snapshot of all settings as read at the top of `display()`. Rendered
 * sections pull their values from this object rather than re-fetching
 * via `loadData()` - see the render-order invariant above.
 */
type SettingsSnapshot = Record<string, unknown>;

const CORE_DEFAULTS: CoreSettings = {
  "core.claudeCommand": "claude",
  "core.claudeExtraArgs": "",
  "core.copilotCommand": "copilot",
  "core.copilotExtraArgs": "",
  "core.strandsCommand": "strands",
  "core.strandsExtraArgs": "",
  "core.defaultShell": process.env.SHELL || "/bin/zsh",
  "core.defaultTerminalCwd": "~",
  "core.exposeDebugApi": false,
  "core.keepSessionsAlive": true,
  "core.enrichmentLogging": true,
  "core.cardDisplayMode": "standard",
  "core.viewMode": "kanban",
  "core.recentThreshold": "3h",
  "core.detailViewPlacement": "split",
  "core.detailViewWidthOverride": true,
  "core.detailViewAutoClose": false,
  "core.detailViewSplitDirection": "vertical",
  "core.showVersionInTabTitle": true,
};

/**
 * Adapter-setting keys that are surfaced inside dedicated dialogs (not the
 * top-level list). Used to filter which adapter fields the General section
 * renders inline.
 */
const ENRICHMENT_DIALOG_KEYS = new Set([
  "enrichmentEnabled",
  "enrichmentMode",
  "enrichmentPrompt",
  "retryEnrichmentPrompt",
  "enrichmentProfile",
  "enrichmentTimeout",
  "retryEnrichmentProfile",
]);
const AGENT_ACTIONS_DIALOG_KEYS = new Set(["splitTaskProfile"]);

export class WorkTerminalSettingsTab extends PluginSettingTab {
  private adapter: AdapterBundle;
  private plugin: Plugin;
  private profileManager: AgentProfileManager;
  private adapterPromptDescription?: string;

  constructor(
    app: App,
    plugin: Plugin,
    adapter: AdapterBundle,
    profileManager: AgentProfileManager,
  ) {
    super(app, plugin);
    this.plugin = plugin;
    this.adapter = adapter;
    this.profileManager = profileManager;

    // Get the adapter's prompt format description for the profile UI
    try {
      const promptBuilder = adapter.createPromptBuilder();
      if (promptBuilder?.describePromptFormat) {
        this.adapterPromptDescription = promptBuilder.describePromptFormat();
      }
    } catch (error) {
      // createPromptBuilder() or describePromptFormat() threw at construction time
      console.warn("[work-terminal] Failed to get adapter prompt format description", error);
    }
  }

  /**
   * Render the settings page. See the render-order invariant at the top
   * of this file: this method MUST be the only entry point that calls
   * `loadData()` during a render pass, and every helper it calls MUST be
   * synchronous. Do not introduce `await` between `new Setting()` calls
   * anywhere on this render path.
   *
   * Obsidian's `PluginSettingTab.display()` returns `void`. We kick off
   * an async load-and-render sequence; `containerEl.empty()` runs first
   * so a stale DOM is never displayed alongside the load. After the
   * `loadData()` promise resolves, every `new Setting(containerEl)` call
   * runs inside a single synchronous block - no interleaving possible.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Tag this render pass. If display() is called again while we're
    // still awaiting loadData(), the newer pass will bump renderSeq,
    // and the older pass will bail out on resume.
    const seq = ++this.renderSeq;
    // Kick off the single load. `loadSnapshotAndRender()` runs in one
    // synchronous block once data has resolved.
    void this.loadSnapshotAndRender(seq);
  }

  private async loadSnapshotAndRender(seq: number): Promise<void> {
    const data = (await this.plugin.loadData()) || {};
    const settings: SettingsSnapshot = data.settings || {};

    // If a second display() fired while we were awaiting, bail out - the
    // newer pass has already called containerEl.empty() and scheduled its
    // own render. Appending now would either duplicate rows or interleave.
    if (seq !== this.renderSeq) return;

    // From here down, everything is synchronous. The render-order
    // invariant depends on this - do NOT introduce `await` between
    // these calls.
    const { containerEl } = this;
    this.renderGeneralSection(containerEl, settings);
    this.renderBoardAndColumnsSection(containerEl, settings);
    this.renderTerminalSection(containerEl);
    this.renderDetailViewSection(containerEl, settings);
    this.renderAgentsSection(containerEl, settings);
  }

  /** Incremented on every display() call; used to abandon stale renders. */
  private renderSeq = 0;

  // ------------------------------------------------------------------ //
  // Section renderers                                                   //
  // ------------------------------------------------------------------ //

  /**
   * General section: task base path, state resolution, view mode, recent
   * threshold, card display mode, card-indicator toggles (showCardIndicators,
   * taskCardIcons, autoIconMode), jiraBaseUrl, keepSessionsAlive,
   * enrichmentLogging, debug API toggle, reset guided tour.
   *
   * Ordering within the section puts frequently-touched items first (view
   * mode, recent threshold, card display) then rarer ones (debug API,
   * enrichment logs).
   */
  private renderGeneralSection(containerEl: HTMLElement, settings: SettingsSnapshot): void {
    containerEl.createEl("h2", { text: "General" });

    // Running plugin version - resolved at build time. Displayed at the top
    // of General so it's the first thing users see when filing a bug report.
    // Uses a plain div (not `new Setting`) to keep it read-only and compact.
    const versionEl = containerEl.createDiv({ cls: "wt-settings-version" });
    versionEl.setAttribute("data-wt-setting-key", "core.version");
    versionEl.style.cssText =
      "margin: 0.25em 0 1em; color: var(--text-muted); font-size: var(--font-ui-smaller);";
    versionEl.createSpan({ text: "Running version: " });
    versionEl.createEl("code", { text: formatVersionForSettings() });

    // Task base path + state strategy are adapter-level but conceptually
    // "where are my tasks stored and how is state computed" - users reach for
    // them during initial setup and rarely after, so they go near the top of
    // the section rather than getting lost at the bottom.
    this.addAdapterSettingByKey(containerEl, settings, "taskBasePath");
    this.addAdapterSettingByKey(containerEl, settings, "stateStrategy");

    this.addCoreDropdown(
      containerEl,
      settings,
      "core.viewMode",
      "View mode",
      "Kanban groups tasks by state columns. Activity groups tasks by recency (recent, last 7 days, last 30 days, older).",
      { kanban: "Kanban (by state)", activity: "Activity (by recency)" },
    );
    this.addCoreDropdown(
      containerEl,
      settings,
      "core.recentThreshold",
      "Recent activity threshold",
      'How far back the "Recent" section extends in activity view. The section always includes today, or the configured threshold, whichever is longer.',
      { "1h": "Last hour", "3h": "Last 3 hours (default)", "24h": "Last 24 hours" },
    );
    this.addCoreDropdown(
      containerEl,
      settings,
      "core.cardDisplayMode",
      "Card display mode",
      "Standard shows full card details. Comfortable adds extra padding and spacing for easier scanning. Compact shows single-line cards with indicator dots replacing verbose badges.",
      { standard: "Standard", comfortable: "Comfortable", compact: "Compact" },
    );

    // Card-indicator adapter toggles live here because they're display
    // preferences (what you see on each card) rather than board layout.
    this.addAdapterSettingByKey(containerEl, settings, "showCardIndicators");
    this.addAdapterSettingByKey(containerEl, settings, "taskCardIcons");
    this.addAdapterSettingByKey(containerEl, settings, "autoIconMode");

    // Jira integration - rarely changed after setup.
    this.addAdapterSettingByKey(containerEl, settings, "jiraBaseUrl");

    // Tab title version display - default ON. Grouped with other display
    // toggles rather than session/lifecycle ones because it's purely a
    // visual preference for the plugin's own tab header.
    this.addCoreToggle(
      containerEl,
      settings,
      "core.showVersionInTabTitle",
      "Show version in tab title",
      "Append the running plugin version (or short commit SHA for untagged builds) to the Work Terminal tab title. Helps quickly confirm which build is running when reporting issues.",
    );

    // Session/lifecycle toggles.
    this.addCoreToggle(
      containerEl,
      settings,
      "core.keepSessionsAlive",
      "Keep sessions alive when tab is closed",
      "Stash terminal sessions to memory instead of killing them when the Work Terminal tab is closed. Reopening the tab restores sessions with full PTY state.",
    );
    this.addCoreToggle(
      containerEl,
      settings,
      "core.enrichmentLogging",
      "Enrichment failure logs",
      "When a background enrichment attempt fails, write a detailed log file (prompt, agent stdout/stderr, error details) to the plugin's logs/ directory. Logs older than 7 days are auto-pruned and only the 50 most recent are retained. Logs may contain task content and agent output - see the user guide for details.",
    );
    this.addCoreToggle(
      containerEl,
      settings,
      "core.exposeDebugApi",
      "Expose debug API",
      "Publishes window.__workTerminalDebug for CDP inspection. Disabled by default because it exposes active session metadata to other renderer plugins.",
    );

    new Setting(containerEl)
      .setName("Reset guided tour")
      .setDesc(
        "Clear guided tour completion status so it starts again next time you open Work Terminal.",
      )
      .addButton((btn) =>
        btn.setButtonText("Reset").onClick(async () => {
          await resetGuidedTourStatus(this.plugin);
          new Notice("Guided tour will start next time you open Work Terminal");
        }),
      );

    // Any remaining adapter settings that aren't claimed by a section-specific
    // renderer end up here so adapters shipping bespoke fields don't silently
    // drop off the UI.
    const handledKeys = new Set<string>([
      "taskBasePath",
      "stateStrategy",
      "jiraBaseUrl",
      "showCardIndicators",
      "taskCardIcons",
      "autoIconMode",
    ]);
    for (const field of this.adapter.config.settingsSchema) {
      if (handledKeys.has(field.key)) continue;
      if (ENRICHMENT_DIALOG_KEYS.has(field.key)) continue;
      if (AGENT_ACTIONS_DIALOG_KEYS.has(field.key)) continue;
      this.addAdapterSetting(containerEl, settings, field);
    }
  }

  /**
   * Board & Columns section: merges the old "Column Order & Creation" and
   * "Card Indicators" sections into one umbrella. Hidden when the adapter
   * provides neither columns nor card-flag defaults (i.e. a minimal adapter
   * with no kanban board).
   */
  private renderBoardAndColumnsSection(containerEl: HTMLElement, settings: SettingsSnapshot): void {
    const hasColumns = this.adapter.config.columns.length > 0;
    const hasCardFlags = this.adapter.config.cardFlags !== undefined;
    if (!hasColumns && !hasCardFlags) return;

    containerEl.createEl("h2", { text: "Board & Columns" });

    if (hasColumns) {
      this.renderColumnOrderControls(containerEl, settings);
      this.renderCreationColumnControls(containerEl);
    }
    if (hasCardFlags) {
      this.addCardFlagRulesButton(containerEl, settings);
    }
  }

  /**
   * Terminal section: surfaces a single "Configure terminal..." button that
   * opens the dedicated TerminalSettingsDialog. Default shell and default
   * terminal CWD live inside the dialog so the top-level page stays scannable
   * and future terminal controls (keyboard-capture toggles, resize behaviour)
   * have room to grow without adding noise here.
   */
  private renderTerminalSection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Terminal" });

    new Setting(containerEl)
      .setName("Configure terminal")
      .setDesc(
        "Open a dialog to configure how new terminal tabs are launched: " +
          "default shell and default working directory. Existing tabs keep " +
          "whatever shell and CWD they were opened with.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Configure terminal...")
          .setCta()
          .onClick(() => {
            const dialog = new TerminalSettingsDialog(this.app, this.plugin, this.adapter);
            const originalOnClose = dialog.onClose.bind(dialog);
            dialog.onClose = () => {
              originalOnClose();
              this.display();
            };
            dialog.open();
          }),
      );
  }

  /**
   * Detail view section: controls how task detail files are opened when a
   * work item is selected. Placement-dependent controls are only shown when
   * they apply (unchanged from the pre-reorganisation behaviour).
   */
  private renderDetailViewSection(containerEl: HTMLElement, settings: SettingsSnapshot): void {
    containerEl.createEl("h2", { text: "Detail view" });
    this.renderDetailViewSettings(containerEl, settings);
  }

  /**
   * Agents section: umbrella heading with Profile Manager, inline additional
   * agent context textarea, and buttons to the Background enrichment and
   * Agent actions dialogs.
   */
  private renderAgentsSection(containerEl: HTMLElement, _settings: SettingsSnapshot): void {
    containerEl.createEl("h2", { text: "Agents" });

    // Profile Manager - first because it's the most frequent touchpoint.
    new Setting(containerEl)
      .setName("Manage agent profiles")
      .setDesc(
        "Configure reusable agent launch profiles with custom commands, arguments, and tab bar buttons.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Open Profile Manager")
          .setCta()
          .onClick(() => {
            new AgentProfileManagerModal(
              this.app,
              this.profileManager,
              this.adapterPromptDescription,
            ).open();
          }),
      );

    // Enrichment dialog button (only if the adapter schema declares
    // enrichment fields).
    const schema = this.adapter.config.settingsSchema;
    const hasEnrichmentSchema = schema.some((field) => ENRICHMENT_DIALOG_KEYS.has(field.key));
    if (hasEnrichmentSchema) {
      new Setting(containerEl)
        .setName("Task enrichment")
        .setDesc(
          "Open a dialog to enable/disable automatic enrichment, choose background " +
            "or foreground launch mode, and customise the enrichment prompt, retry " +
            "prompt, agent profile, and timeout. The built-in default prompts are " +
            "displayed inside the dialog so you can read them before deciding " +
            "whether to override.",
        )
        .addButton((btn) =>
          btn
            .setButtonText("Configure enrichment...")
            .setCta()
            .onClick(() => {
              new EnrichmentSettingsDialog(
                this.app,
                this.plugin,
                this.adapter,
                this.profileManager,
              ).open();
            }),
        );
    }

    // Agent actions dialog button (only if the adapter schema declares
    // agent-action bindings).
    const hasAgentActionsSchema = schema.some((field) => AGENT_ACTIONS_DIALOG_KEYS.has(field.key));
    if (hasAgentActionsSchema) {
      new Setting(containerEl)
        .setName("Agent actions")
        .setDesc(
          "Open a dialog to bind agent profiles to adapter-driven actions " +
            "(currently Split Task). Defaults fall back through the available Claude-family " +
            "profiles so users who never open this dialog still get profile-aware launches. " +
            "The Retry Enrichment profile lives in the Configure enrichment... dialog.",
        )
        .addButton((btn) =>
          btn
            .setButtonText("Configure agent actions...")
            .setCta()
            .onClick(() => {
              const dialog = new AgentActionsDialog(
                this.app,
                this.plugin,
                this.adapter,
                this.profileManager,
              );
              const originalOnClose = dialog.onClose.bind(dialog);
              dialog.onClose = () => {
                originalOnClose();
                this.display();
              };
              dialog.open();
            }),
        );
    }
  }

  // ------------------------------------------------------------------ //
  // Helpers                                                             //
  // ------------------------------------------------------------------ //

  /**
   * Render an adapter setting by schema key, no-op if the adapter doesn't
   * declare that key. Used to pull specific adapter fields into the General
   * section at chosen positions.
   */
  private addAdapterSettingByKey(
    containerEl: HTMLElement,
    settings: SettingsSnapshot,
    key: string,
  ): void {
    const field = this.adapter.config.settingsSchema.find((f) => f.key === key);
    if (!field) return;
    this.addAdapterSetting(containerEl, settings, field);
  }

  private async saveSettings(update: (settings: Record<string, unknown>) => void): Promise<void> {
    await mergeAndSavePluginData(this.plugin, async (data) => {
      if (!data.settings) data.settings = {};
      update(data.settings);
    });
    const allSettings = await loadAllSettings(this.plugin, this.adapter);
    // Update adapter config directly so settings UI stays current even when
    // the Work Terminal view is not open (and thus no MainView listener exists).
    this.adapter.onSettingsChanged?.(allSettings);
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: allSettings }));
  }

  /**
   * Synchronous (issue #473). The value is read from the pre-loaded
   * snapshot; only the onChange handler awaits (for persistence), which
   * runs in response to user input - well after render - so it cannot
   * affect render order.
   */
  private addCoreToggle(
    containerEl: HTMLElement,
    settings: SettingsSnapshot,
    key: keyof CoreSettings,
    name: string,
    description: string,
    tourId?: string,
  ): void {
    const value = settings[key] ?? CORE_DEFAULTS[key];

    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) =>
        toggle.setValue(!!value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue;
          });
        }),
      );
    if (tourId) {
      setting.settingEl.setAttribute("data-wt-tour", tourId);
    }
  }

  /**
   * Synchronous (issue #473). See `addCoreToggle` for rationale.
   */
  private addCoreDropdown(
    containerEl: HTMLElement,
    settings: SettingsSnapshot,
    key: keyof CoreSettings,
    name: string,
    description: string,
    choices: Record<string, string>,
  ): void {
    const value = settings[key] ?? CORE_DEFAULTS[key];

    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addDropdown((dropdown) => {
        for (const [val, label] of Object.entries(choices)) {
          dropdown.addOption(val, label);
        }
        dropdown.setValue(String(value || "")).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue;
          });
        });
      });
  }

  /**
   * Render the Detail view settings group: placement dropdown plus
   * placement-dependent width override, auto-close, and split direction
   * controls. Re-renders the whole settings page on placement change so the
   * conditional controls appear or disappear.
   *
   * Synchronous (issue #473): reads from the snapshot.
   */
  private renderDetailViewSettings(containerEl: HTMLElement, settings: SettingsSnapshot): void {
    // Resolve via resolveDetailViewOptions so invalid persisted values (from
    // manual edits or older plugin versions) fall back to the default and
    // the dropdown/conditional rendering stay consistent.
    const placement = resolveDetailViewOptions(settings).placement;

    // Placement dropdown - drives visibility of other fields in this section.
    new Setting(containerEl)
      .setName("Placement")
      .setDesc(
        "How the task file opens when you select a work item. " +
          "Split opens a new split beside the Work Terminal view (default). " +
          "Tab opens a new tab in the active tab group. " +
          "Navigate replaces the contents of the active editor. " +
          "Preview shows a read-only markdown preview of the file inside the Work Terminal panel, with an Open in editor button. " +
          "Embedded (experimental) renders the detail view inside the terminal panel as a pseudo-tab, alongside shell and agent tabs. " +
          "Disabled does nothing - open files manually via the file explorer or quick switcher.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("split", "Split (default)");
        dropdown.addOption("tab", "Tab in active group");
        dropdown.addOption("navigate", "Navigate active leaf");
        dropdown.addOption("preview", "Preview in Work Terminal panel");
        dropdown.addOption("embedded", "Embedded in terminal panel (experimental)");
        dropdown.addOption("disabled", "Disabled");
        dropdown.setValue(placement).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s["core.detailViewPlacement"] = newValue;
          });
          // Re-render to update visibility of placement-dependent settings
          this.display();
        });
      });

    // Embedded placement is experimental - surface a warning so users know
    // what they are opting into. Only shown when this placement is selected.
    if (placement === "embedded") {
      const warning = containerEl.createDiv({ cls: "wt-setting-experimental-note" });
      warning.createSpan({ text: "Experimental: ", cls: "wt-setting-experimental-label" });
      warning.appendText(
        "the embedded placement reparents an Obsidian MarkdownView into a host element " +
          "inside the terminal panel. It relies on internal Obsidian APIs and may break " +
          "across Obsidian versions. If you hit issues, switch back to Split or Tab placement.",
      );
    }

    // Auto-close applies to any placement except "disabled" (where nothing is
    // opened anyway). It's a general behaviour toggle, not split-specific.
    if (placement !== "disabled") {
      this.addCoreToggle(
        containerEl,
        settings,
        "core.detailViewAutoClose",
        "Auto-close on selection change",
        "Detach the detail leaf when you select a different item, opening a fresh one at the current placement target. When off, the same leaf is reused across selections.",
      );
    }

    // Width override and split direction only apply when placement is "split".
    if (placement === "split") {
      this.addCoreToggle(
        containerEl,
        settings,
        "core.detailViewWidthOverride",
        "Apply readable line-width override to split",
        "Forces the editor split to the Obsidian readable line width and lets the terminal panel fill the rest. Turn off if you prefer Obsidian's default flex sizing for the split.",
      );
      this.addCoreDropdown(
        containerEl,
        settings,
        "core.detailViewSplitDirection",
        "Split direction",
        "Orientation of the split created alongside the Work Terminal view. Vertical stacks side-by-side; horizontal stacks top-and-bottom.",
        { vertical: "Vertical (side by side)", horizontal: "Horizontal (top and bottom)" },
      );
    }
  }

  /**
   * Synchronous (issue #473): reads from the snapshot.
   */
  private addCardFlagRulesButton(containerEl: HTMLElement, settings: SettingsSnapshot): void {
    const customJson = (settings["adapter.customCardFlags"] as string) || "[]";
    const customRules = parseCardFlagRulesJson(customJson);
    const defaultRules = this.adapter.config.cardFlags || [];

    const ruleCount = customRules.length;
    const description =
      ruleCount === 0
        ? "Define custom rules that match frontmatter fields and display visual indicators on task cards."
        : `${ruleCount} custom rule${ruleCount === 1 ? "" : "s"} defined. Click to manage.`;

    new Setting(containerEl)
      .setName("Custom card flag rules")
      .setDesc(description)
      .addButton((btn) =>
        btn
          .setButtonText("Manage Rules")
          .setCta()
          .onClick(() => {
            new CardFlagManagerModal(
              this.app,
              customRules,
              defaultRules,
              async (updatedRules: CardFlagRule[]) => {
                const json = serializeCardFlagRules(updatedRules);
                await this.saveSettings((s) => {
                  s["adapter.customCardFlags"] = json;
                });
                // Refresh the settings display to update the rule count
                this.display();
              },
            ).open();
          }),
      );
  }

  /**
   * Render column display order controls: a list of columns with up/down
   * buttons, pin toggles for dynamic columns, and a reset-to-default action.
   *
   * Synchronous (issue #473): reads from the snapshot.
   */
  private renderColumnOrderControls(containerEl: HTMLElement, settings: SettingsSnapshot): void {
    // Resolve effective column order (current config reflects it)
    const columns = this.adapter.config.columns;

    // Load pinned custom states from snapshot
    const pinnedJson = (settings["adapter.pinnedCustomStates"] as string) || "[]";
    let pinnedStates: string[] = [];
    try {
      const parsed = JSON.parse(pinnedJson);
      if (Array.isArray(parsed)) pinnedStates = parsed;
    } catch {
      /* empty */
    }
    const pinnedSet = new Set(pinnedStates);

    const hasDynamic = columns.some((c) => !c.folderName);
    const desc = new Setting(containerEl)
      .setName("Column display order")
      .setDesc(
        hasDynamic
          ? "Use arrow buttons to reorder kanban board columns. Dynamic columns (from custom frontmatter states) are shown with a star. Use the pin button to keep a dynamic column visible even when it has no tasks. Changes take effect immediately."
          : "Use arrow buttons to reorder kanban board columns. Changes take effect immediately.",
      );

    // Reset button
    desc.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        await this.saveSettings((s) => {
          s["adapter.columnOrder"] = "";
          s["adapter.pinnedCustomStates"] = "[]";
        });
        this.display();
      }),
    );

    const listEl = containerEl.createDiv({ cls: "wt-column-order-list" });

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const rowEl = listEl.createDiv({ cls: "wt-column-order-row" });

      // Column label (with dynamic indicator for custom frontmatter states)
      const isDynamic = !col.folderName;
      const isPinned = isDynamic && pinnedSet.has(col.id);
      const labelText = isDynamic ? `${col.label} *${isPinned ? " (pinned)" : ""}` : col.label;
      rowEl.createSpan({ text: labelText, cls: "wt-column-order-label" });

      // Pin toggle for dynamic columns
      if (isDynamic) {
        const pinBtn = rowEl.createEl("button", {
          text: isPinned ? "Unpin" : "Pin",
          cls: "wt-column-order-btn wt-column-pin-btn",
          attr: { "aria-label": isPinned ? `Unpin ${col.label}` : `Pin ${col.label}` },
        });
        pinBtn.addEventListener("click", async () => {
          const currentPinned = new Set(pinnedStates);
          if (isPinned) {
            currentPinned.delete(col.id);
          } else {
            currentPinned.add(col.id);
          }
          await this.saveSettings((s) => {
            s["adapter.pinnedCustomStates"] = JSON.stringify([...currentPinned]);
          });
          this.display();
        });
      }

      // Up button
      const upBtn = rowEl.createEl("button", {
        text: "\u2191",
        cls: "wt-column-order-btn",
        attr: { "aria-label": `Move ${col.label} up` },
      });
      if (i === 0) upBtn.setAttribute("disabled", "true");
      upBtn.addEventListener("click", async () => {
        if (i === 0) return;
        const ids = columns.map((c) => c.id);
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        await this.saveSettings((s) => {
          s["adapter.columnOrder"] = JSON.stringify(ids);
        });
        this.display();
      });

      // Down button
      const downBtn = rowEl.createEl("button", {
        text: "\u2193",
        cls: "wt-column-order-btn",
        attr: { "aria-label": `Move ${col.label} down` },
      });
      if (i === columns.length - 1) downBtn.setAttribute("disabled", "true");
      downBtn.addEventListener("click", async () => {
        if (i === columns.length - 1) return;
        const ids = columns.map((c) => c.id);
        [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
        await this.saveSettings((s) => {
          s["adapter.columnOrder"] = JSON.stringify(ids);
        });
        this.display();
      });
    }

    // "Create custom state" input
    this.renderCreateCustomStateInput(containerEl, pinnedStates);
  }

  /**
   * Render an input for creating a new custom state column.
   * Newly created states are pinned by default so they remain visible.
   */
  private renderCreateCustomStateInput(
    containerEl: HTMLElement,
    currentPinnedStates: string[],
  ): void {
    const existingIds = new Set(this.adapter.config.columns.map((c) => c.id));

    new Setting(containerEl)
      .setName("Create custom state")
      .setDesc(
        "Add a new custom state column. The column will be pinned by default so it stays visible even with no tasks. Use lowercase identifiers with hyphens (e.g. review, blocked-upstream).",
      )
      .addText((text) => {
        text.inputEl.placeholder = "e.g. review";
        text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const value = text.inputEl.value.trim().toLowerCase().replace(/\s+/g, "-");
          if (!value) return;
          if (existingIds.has(value)) {
            new Notice(`Column "${value}" already exists`);
            return;
          }

          // Add to column order and pin it
          const columns = this.adapter.config.columns;
          const ids = columns.map((c) => c.id);
          ids.push(value);
          const newPinned = [...currentPinnedStates, value];

          await this.saveSettings((s) => {
            s["adapter.columnOrder"] = JSON.stringify(ids);
            s["adapter.pinnedCustomStates"] = JSON.stringify(newPinned);
          });
          new Notice(`Custom state "${value}" created and pinned`);
          this.display();
        });
      });
  }

  /**
   * Render creation column selection: checkboxes for each column, with
   * the ability to toggle which columns appear in the new item prompt
   * and reorder them.
   */
  private renderCreationColumnControls(containerEl: HTMLElement): void {
    // All available columns from the adapter
    const allColumns = this.adapter.config.columns;
    // Current creation columns
    const creationColumns = this.adapter.config.creationColumns;
    const creationIds = new Set(creationColumns.map((c) => c.id));
    const defaultId = creationColumns.find((c) => c.default)?.id || creationColumns[0]?.id;

    const desc = new Setting(containerEl)
      .setName("New item column selector")
      .setDesc(
        `Choose which columns appear in the "${this.adapter.config.itemName}" creation prompt. The first checked column is the default. Uncheck to hide a column from the creation dropdown.`,
      );

    desc.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        await this.saveSettings((s) => {
          s["adapter.creationColumnIds"] = "";
        });
        this.display();
      }),
    );

    const listEl = containerEl.createDiv({ cls: "wt-creation-column-list" });

    // Show creation columns first (in order), then unchecked columns
    const orderedColumns = [
      ...creationColumns.map((cc) => allColumns.find((ac) => ac.id === cc.id)!).filter(Boolean),
      ...allColumns.filter((ac) => !creationIds.has(ac.id)),
    ];

    for (let i = 0; i < orderedColumns.length; i++) {
      const col = orderedColumns[i];
      const isChecked = creationIds.has(col.id);
      const isDefault = col.id === defaultId;

      const rowEl = listEl.createDiv({ cls: "wt-creation-column-row" });

      // Checkbox
      const checkbox = rowEl.createEl("input", {
        attr: {
          type: "checkbox",
          ...(isChecked ? { checked: "" } : {}),
        },
      });
      checkbox.checked = isChecked;

      // Label with default indicator
      const labelText = isDefault ? `${col.label} (default)` : col.label;
      rowEl.createSpan({ text: labelText, cls: "wt-creation-column-label" });

      // Up button (only for checked items)
      if (isChecked) {
        const creationIdx = creationColumns.findIndex((c) => c.id === col.id);
        const upBtn = rowEl.createEl("button", {
          text: "\u2191",
          cls: "wt-column-order-btn",
          attr: { "aria-label": `Move ${col.label} up` },
        });
        if (creationIdx === 0) upBtn.setAttribute("disabled", "true");
        upBtn.addEventListener("click", async () => {
          if (creationIdx === 0) return;
          const ids = creationColumns.map((c) => c.id);
          [ids[creationIdx - 1], ids[creationIdx]] = [ids[creationIdx], ids[creationIdx - 1]];
          await this.saveSettings((s) => {
            s["adapter.creationColumnIds"] = JSON.stringify(ids);
          });
          this.display();
        });

        const downBtn = rowEl.createEl("button", {
          text: "\u2193",
          cls: "wt-column-order-btn",
          attr: { "aria-label": `Move ${col.label} down` },
        });
        if (creationIdx === creationColumns.length - 1) downBtn.setAttribute("disabled", "true");
        downBtn.addEventListener("click", async () => {
          if (creationIdx === creationColumns.length - 1) return;
          const ids = creationColumns.map((c) => c.id);
          [ids[creationIdx], ids[creationIdx + 1]] = [ids[creationIdx + 1], ids[creationIdx]];
          await this.saveSettings((s) => {
            s["adapter.creationColumnIds"] = JSON.stringify(ids);
          });
          this.display();
        });
      }

      // Toggle checkbox handler
      checkbox.addEventListener("change", async () => {
        const currentIds = creationColumns.map((c) => c.id);
        if (checkbox.checked) {
          // Add this column at the end
          currentIds.push(col.id);
        } else {
          // Remove this column (must keep at least one)
          const idx = currentIds.indexOf(col.id);
          if (idx >= 0 && currentIds.length > 1) {
            currentIds.splice(idx, 1);
          } else if (currentIds.length <= 1) {
            checkbox.checked = true; // Prevent unchecking the last one
            new Notice("At least one creation column must remain selected");
            return;
          }
        }
        await this.saveSettings((s) => {
          s["adapter.creationColumnIds"] = JSON.stringify(currentIds);
        });
        this.display();
      });
    }
  }

  /**
   * Synchronous (issue #473): reads from the snapshot.
   */
  private addAdapterSetting(
    containerEl: HTMLElement,
    settings: SettingsSnapshot,
    field: SettingField,
  ): void {
    const key = `adapter.${field.key}`;
    const defaultVal = this.adapter.config.defaultSettings[field.key] ?? field.default;
    const value = settings[key] ?? defaultVal;

    const setting = new Setting(containerEl).setName(field.name).setDesc(field.description);

    if (field.type === "text") {
      setting.addText((text) =>
        text.setValue(String(value)).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue;
          });
        }),
      );
    } else if (field.type === "toggle") {
      setting.addToggle((toggle) =>
        toggle.setValue(!!value).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue;
          });
        }),
      );
    } else if (field.type === "dropdown") {
      let choices: Record<string, string>;
      if (field.choices === "profiles") {
        // Dynamically populate from agent profiles
        choices = { "": "Default (core settings)" };
        for (const profile of this.profileManager.getProfiles()) {
          choices[profile.id] = profile.name;
        }
      } else {
        choices = (field.choices as Record<string, string>) || {};
      }
      setting.addDropdown((dropdown) => {
        for (const [val, label] of Object.entries(choices)) {
          dropdown.addOption(val, label);
        }
        dropdown.setValue(String(value || "")).onChange(async (newValue) => {
          await this.saveSettings((s) => {
            s[key] = newValue;
          });
        });
      });
    }
  }
}

/**
 * Load a specific setting value from plugin data.
 * Used by framework components to read settings at runtime.
 */
export async function loadSetting(plugin: Plugin, key: string): Promise<any> {
  const data = (await plugin.loadData()) || {};
  const settings = data.settings || {};
  if (key in settings) return settings[key];
  if (key in CORE_DEFAULTS) return CORE_DEFAULTS[key as keyof CoreSettings];
  return undefined;
}

/**
 * Load all settings as a flat object (merged defaults + saved).
 */
export async function loadAllSettings(
  plugin: Plugin,
  adapter: AdapterBundle,
): Promise<Record<string, any>> {
  const data = (await plugin.loadData()) || {};
  const saved = data.settings || {};
  const result: Record<string, any> = { ...CORE_DEFAULTS };

  // Merge adapter defaults
  for (const field of adapter.config.settingsSchema) {
    const key = `adapter.${field.key}`;
    result[key] = adapter.config.defaultSettings[field.key] ?? field.default;
  }

  // Override with saved values
  for (const [k, v] of Object.entries(saved)) {
    result[k] = v;
  }

  return result;
}
