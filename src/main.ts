/**
 * Entry point: concrete plugin class with hardcoded adapter import.
 */
import type { App, PluginManifest } from "obsidian";
import { PluginBase } from "./framework/PluginBase";
import { TaskAgentAdapter } from "./adapters/task-agent";

export default class WorkTerminalPlugin extends PluginBase {
  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest, new TaskAgentAdapter());
  }
}
