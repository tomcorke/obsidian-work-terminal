/**
 * AgentProfileManager - CRUD, import/export, and migration for agent profiles.
 *
 * Profiles are stored in a standalone JSON file (see ProfileFileStore) so they
 * can be hand-edited and backed up independently of plugin data. On first load
 * with no profiles file, profiles are migrated from the plugin data key
 * "agentProfiles" or, failing that, from the legacy per-agent settings keys.
 */
import type { PluginDataStore } from "../PluginDataStore";
import { createProfileFileStore, type ProfileFileStore } from "./ProfileFileStore";
import {
  type AgentProfile,
  type AgentType,
  AgentProfileArraySchema,
  StoredProfileArraySchema,
  createDefaultProfile,
  createDefaultClaudeProfile,
  createDefaultClaudeCtxProfile,
  createDefaultCopilotProfile,
  getBuiltInProfiles,
  getLaunchConfig,
} from "./AgentProfile";

const PROFILES_KEY = "agentProfiles";

export const PROFILES_CHANGED_EVENT = "work-terminal:agent-profiles-changed";

export class AgentProfileManager {
  private profiles: AgentProfile[] = [];
  private loaded = false;

  constructor(
    private plugin: PluginDataStore,
    private file: ProfileFileStore = createProfileFileStore(),
  ) {}

  /** Path of the profiles file, for display in the UI. */
  get profilesPath(): string {
    return this.file.path;
  }

  // ---------------------------------------------------------------------------
  // Load / Save
  // ---------------------------------------------------------------------------

  async load(): Promise<AgentProfile[]> {
    let stored: unknown[] | null;
    try {
      stored = await this.file.read();
    } catch (err) {
      // File exists but is unreadable or not a JSON array. Do NOT overwrite it -
      // fall back in-memory so the user can fix the file by hand.
      console.warn(
        `[work-terminal] Could not read profiles file ${this.file.path} (kept on disk, using built-in defaults in-memory):`,
        err,
      );
      this.profiles = getBuiltInProfiles();
      this.loaded = true;
      return this.getProfiles();
    }

    if (stored) {
      // Use the lenient schema for loading stored profiles - tolerates missing
      // fields from older versions so user customisations are never discarded.
      const result = StoredProfileArraySchema.safeParse(stored);
      if (result.success) {
        this.profiles = result.data as AgentProfile[];
      } else {
        // Even the lenient schema failed - profiles are seriously malformed.
        // Log but do NOT overwrite the file; fall back in-memory only so the
        // user can fix the file on disk.
        console.warn(
          "[work-terminal] Stored profiles failed validation (kept on disk, using built-in defaults in-memory):",
          result.error.issues,
        );
        this.profiles = getBuiltInProfiles();
      }
    } else {
      // No profiles file yet - migrate from plugin data and write the file.
      this.profiles = this.migrateFromPluginData((await this.plugin.loadData()) || {});
      await this.save();
    }

    this.loaded = true;
    return this.getProfiles();
  }

  /** Re-read the profiles file, picking up edits made outside the plugin. */
  async reload(): Promise<AgentProfile[]> {
    const profiles = await this.load();
    this.notifyChanged();
    return profiles;
  }

  /**
   * One-time migration into the profiles file. Profiles previously lived in
   * plugin data under "agentProfiles"; before that, in per-agent settings keys.
   * The old plugin data key is left untouched so downgrades keep working.
   */
  private migrateFromPluginData(data: Record<string, any>): AgentProfile[] {
    if (!Array.isArray(data[PROFILES_KEY])) {
      return this.migrateFromLegacySettings(data);
    }
    const result = StoredProfileArraySchema.safeParse(data[PROFILES_KEY]);
    if (result.success) {
      return result.data as AgentProfile[];
    }
    console.warn(
      "[work-terminal] Profiles in plugin data failed validation - migrating built-in defaults instead:",
      result.error.issues,
    );
    return getBuiltInProfiles();
  }

  private migrateFromLegacySettings(data: Record<string, any>): AgentProfile[] {
    const settings = data.settings || {};
    const profiles: AgentProfile[] = [];

    // Migrate Claude profile from legacy settings
    const claudeProfile = createDefaultClaudeProfile(0);
    const claudeCommand = settings["core.claudeCommand"];
    if (typeof claudeCommand === "string" && claudeCommand.trim()) {
      claudeProfile.command = claudeCommand.trim();
    }
    const claudeExtraArgs = settings["core.claudeExtraArgs"];
    if (typeof claudeExtraArgs === "string" && claudeExtraArgs.trim()) {
      claudeProfile.arguments = claudeExtraArgs.trim();
    }
    profiles.push(claudeProfile);

    // Migrate Claude (ctx) profile
    const claudeCtxProfile = createDefaultClaudeCtxProfile(1);
    if (typeof claudeCommand === "string" && claudeCommand.trim()) {
      claudeCtxProfile.command = claudeCommand.trim();
    }
    if (typeof claudeExtraArgs === "string" && claudeExtraArgs.trim()) {
      claudeCtxProfile.arguments = claudeExtraArgs.trim();
    }
    profiles.push(claudeCtxProfile);

    // Migrate Copilot profile
    const copilotProfile = createDefaultCopilotProfile(2);
    const copilotCommand = settings["core.copilotCommand"];
    if (typeof copilotCommand === "string" && copilotCommand.trim()) {
      copilotProfile.command = copilotCommand.trim();
    }
    const copilotExtraArgs = settings["core.copilotExtraArgs"];
    if (typeof copilotExtraArgs === "string" && copilotExtraArgs.trim()) {
      copilotProfile.arguments = copilotExtraArgs.trim();
    }
    profiles.push(copilotProfile);

    // Migrate Strands if configured
    const strandsCommand = settings["core.strandsCommand"];
    if (typeof strandsCommand === "string" && strandsCommand.trim()) {
      const strandsProfile = createDefaultProfile({
        name: "Strands",
        agentType: "strands",
        command: strandsCommand.trim(),
        button: {
          enabled: false,
          label: "Strands",
          icon: "aws",
          borderStyle: "solid",
        },
        sortOrder: 3,
      });
      const strandsExtraArgs = settings["core.strandsExtraArgs"];
      if (typeof strandsExtraArgs === "string" && strandsExtraArgs.trim()) {
        strandsProfile.arguments = strandsExtraArgs.trim();
      }
      profiles.push(strandsProfile);
    }

    return profiles;
  }

  private async save(): Promise<void> {
    // Write failures propagate so callers can surface them - silently dropping a
    // profile edit loses user data.
    await this.file.write(this.getProfiles());
    this.notifyChanged();
  }

  private notifyChanged(): void {
    window.dispatchEvent(new CustomEvent(PROFILES_CHANGED_EVENT, { detail: this.getProfiles() }));
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  getProfiles(): AgentProfile[] {
    return [...this.profiles].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  getProfilesByType(agentType: AgentType): AgentProfile[] {
    return this.getProfiles().filter((p) => p.agentType === agentType);
  }

  getButtonProfiles(): AgentProfile[] {
    return this.getProfiles().filter((p) => p.button.enabled);
  }

  async addProfile(profile: AgentProfile): Promise<void> {
    this.profiles.push(profile);
    await this.save();
  }

  async updateProfile(id: string, updates: Partial<AgentProfile>): Promise<void> {
    const index = this.profiles.findIndex((p) => p.id === id);
    if (index === -1) return;
    this.profiles[index] = { ...this.profiles[index], ...updates, id };
    await this.save();
  }

  async deleteProfile(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    await this.save();
  }

  async reorderProfiles(orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      const profile = this.profiles.find((p) => p.id === orderedIds[i]);
      if (profile) {
        profile.sortOrder = i;
      }
    }
    await this.save();
  }

  // ---------------------------------------------------------------------------
  // Import / Export
  // ---------------------------------------------------------------------------

  exportProfiles(): string {
    return JSON.stringify(this.getProfiles(), null, 2);
  }

  /**
   * Import profiles from JSON string.
   * Validates with zod. Returns the number of profiles imported.
   * Imported profiles get new IDs to avoid collisions.
   */
  async importProfiles(json: string): Promise<{ imported: number; errors: string[] }> {
    const errors: string[] = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { imported: 0, errors: ["Invalid JSON"] };
    }

    const result = AgentProfileArraySchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${issue.path.join(".")}: ${issue.message}`);
      }
      return { imported: 0, errors };
    }

    const imported = result.data;
    const maxOrder = this.profiles.reduce((max, p) => Math.max(max, p.sortOrder), -1);

    for (let i = 0; i < imported.length; i++) {
      const profile = imported[i] as AgentProfile;
      // Assign new ID to avoid collisions
      profile.id = crypto.randomUUID();
      profile.sortOrder = maxOrder + 1 + i;
      this.profiles.push(profile);
    }

    await this.save();
    return { imported: imported.length, errors };
  }

  // ---------------------------------------------------------------------------
  // Resolve profile settings to launch parameters
  // ---------------------------------------------------------------------------

  /**
   * Resolve a profile's command, falling back to the global setting.
   * Empty profile command means "use the global default for this agent type".
   */
  resolveCommand(profile: AgentProfile, settings: Record<string, unknown>): string {
    if (profile.command.trim()) {
      return profile.command.trim();
    }
    // Fall back to global settings via AgentResumeConfig
    const config = getLaunchConfig(profile.agentType);
    const shellFallback = profile.agentType === "shell" ? process.env.SHELL || "/bin/zsh" : "";
    return String(settings[config.commandSettingKey] || config.defaultCommand || shellFallback);
  }

  /**
   * Resolve a profile's CWD, falling back to the global setting.
   */
  resolveCwd(profile: AgentProfile, settings: Record<string, unknown>): string {
    if (profile.defaultCwd.trim()) {
      return profile.defaultCwd.trim();
    }
    return String(settings["core.defaultTerminalCwd"] || "~");
  }

  /**
   * Resolve a profile's arguments, merging with global defaults.
   */
  resolveArguments(profile: AgentProfile, settings: Record<string, unknown>): string {
    const profileArgs = profile.arguments.trim();
    // Global args (for backward compatibility) via AgentResumeConfig
    const config = getLaunchConfig(profile.agentType);
    const globalArgs = config.extraArgsSettingKey
      ? String(settings[config.extraArgsSettingKey] || "")
      : "";
    const parts = [globalArgs.trim(), profileArgs].filter(Boolean);
    return parts.join(" ");
  }

  /**
   * Resolve a profile's context prompt. Returns the profile's trimmed
   * contextPrompt or an empty string when the profile has none configured.
   */
  resolveContextPrompt(profile: AgentProfile, _settings: Record<string, unknown>): string {
    return profile.contextPrompt.trim();
  }
}
