/**
 * Canonical view type identifier for the Work Terminal Obsidian view.
 *
 * Extracted into its own module (with no Obsidian `Plugin` dependency) so it
 * can be imported by lightweight consumers - including modules that are
 * loaded by tests which mock `obsidian` without a `Plugin` export - without
 * pulling in `PluginBase` and the Obsidian `Plugin` superclass.
 */
export const VIEW_TYPE = "work-terminal-view";
