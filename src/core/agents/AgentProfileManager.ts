/**
 * AgentProfileManager - CRUD, import/export, and migration for agent profiles.
 *
 * Profiles are stored in the plugin data store under the key "agentProfiles".
 * Migration from legacy settings happens on first load when no profiles exist.
 */
import type { PluginDataStore } from "../PluginDataStore";
import { mergeAndSavePluginData } from "../PluginDataStore";
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
} from "./AgentProfile";

const PROFILES_KEY = "agentProfiles";
const MIGRATED_KEY = "agentProfilesMigrated";

export const PROFILES_CHANGED_EVENT = "work-terminal:agent-profiles-changed";

export class AgentProfileManager {
  private profiles: AgentProfile[] = [];
  private loaded = false;

  constructor(private plugin: PluginDataStore) {}

  // ---------------------------------------------------------------------------
  // Load / Save
  // ---------------------------------------------------------------------------

  async load(): Promise<AgentProfile[]> {
    const data = (await this.plugin.loadData()) || {};

    if (data[PROFILES_KEY] && Array.isArray(data[PROFILES_KEY])) {
      // Use the lenient schema for loading stored profiles - tolerates missing
      // fields from older versions so user customisations are never discarded.
      const result = StoredProfileArraySchema.safeParse(data[PROFILES_KEY]);
      if (result.success) {
        this.profiles = result.data as AgentProfile[];
      } else {
        // Even the lenient schema failed - profiles are seriously malformed.
        // Log but do NOT overwrite the stored data; fall back in-memory only
        // so the user can export/fix via settings on next open.
        console.warn(
          "[work-terminal] Stored profiles failed validation (kept on disk, using built-in defaults in-memory):",
          result.error.issues,
        );
        this.profiles = getBuiltInProfiles();
      }
    } else if (!data[MIGRATED_KEY]) {
      // First load - migrate from legacy settings or create defaults
      this.profiles = this.migrateFromLegacySettings(data);
      await this.saveAndMark(true);
    } else {
      // Migrated but no profiles in data - this can happen if data.json was
      // partially written or corrupted. Use defaults in-memory but do NOT
      // overwrite the file (avoids permanently losing profiles if the read
      // was the one at fault).
      console.warn(
        "[work-terminal] agentProfilesMigrated is set but no profiles found in data - using built-in defaults without overwriting disk",
      );
      this.profiles = getBuiltInProfiles();
    }

    this.loaded = true;
    return this.getProfiles();
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
    const additionalContext = settings["core.additionalAgentContext"];
    if (typeof additionalContext === "string" && additionalContext.trim()) {
      claudeCtxProfile.contextPrompt = additionalContext.trim();
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
    await mergeAndSavePluginData(this.plugin, async (data) => {
      data[PROFILES_KEY] = this.profiles;
    });
    this.notifyChanged();
  }

  private async saveAndMark(migrated: boolean): Promise<void> {
    await mergeAndSavePluginData(this.plugin, async (data) => {
      data[PROFILES_KEY] = this.profiles;
      if (migrated) {
        data[MIGRATED_KEY] = true;
      }
    });
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
    // Fall back to global settings
    switch (profile.agentType) {
      case "claude":
        return String(settings["core.claudeCommand"] || "claude");
      case "copilot":
        return String(settings["core.copilotCommand"] || "copilot");
      case "strands":
        return String(settings["core.strandsCommand"] || "strands");
      case "shell":
        return String(settings["core.defaultShell"] || process.env.SHELL || "/bin/zsh");
    }
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
    // Global args (for backward compatibility)
    let globalArgs = "";
    switch (profile.agentType) {
      case "claude":
        globalArgs = String(settings["core.claudeExtraArgs"] || "");
        break;
      case "copilot":
        globalArgs = String(settings["core.copilotExtraArgs"] || "");
        break;
      case "strands":
        globalArgs = String(settings["core.strandsExtraArgs"] || "");
        break;
    }
    const parts = [globalArgs.trim(), profileArgs].filter(Boolean);
    return parts.join(" ");
  }

  /**
   * Resolve a profile's context prompt, falling back to the global setting.
   */
  resolveContextPrompt(profile: AgentProfile, settings: Record<string, unknown>): string {
    if (profile.contextPrompt.trim()) {
      return profile.contextPrompt.trim();
    }
    return String(settings["core.additionalAgentContext"] || "");
  }
}
