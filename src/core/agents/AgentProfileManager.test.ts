// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../PluginDataStore", () => ({
  mergeAndSavePluginData: async (
    plugin: {
      loadData: () => Promise<Record<string, any> | null>;
      saveData: (data: Record<string, any>) => Promise<void>;
    },
    update: (data: Record<string, any>) => void | Promise<void>,
  ) => {
    const data = (await plugin.loadData()) || {};
    await update(data);
    await plugin.saveData(data);
  },
}));

import { AgentProfileManager } from "./AgentProfileManager";
import { createDefaultProfile } from "./AgentProfile";

function createMockPlugin(initialData: Record<string, any> = {}) {
  let data = { ...initialData };
  return {
    loadData: vi.fn(async () => ({ ...data })),
    saveData: vi.fn(async (newData: Record<string, any>) => {
      data = { ...newData };
    }),
    _getData: () => data,
  };
}

describe("AgentProfileManager", () => {
  let plugin: ReturnType<typeof createMockPlugin>;
  let manager: AgentProfileManager;

  beforeEach(() => {
    plugin = createMockPlugin();
    manager = new AgentProfileManager(plugin);
  });

  describe("load", () => {
    it("creates default profiles on first load", async () => {
      await manager.load();
      const profiles = manager.getProfiles();
      expect(profiles.length).toBeGreaterThanOrEqual(3);
      expect(profiles.find((p) => p.name === "Claude")).toBeTruthy();
      expect(profiles.find((p) => p.name === "Claude (ctx)")).toBeTruthy();
      expect(profiles.find((p) => p.name === "Copilot")).toBeTruthy();
    });

    it("loads existing profiles from stored data", async () => {
      const existing = [createDefaultProfile({ name: "Test Profile", sortOrder: 0 })];
      plugin = createMockPlugin({ agentProfiles: existing });
      manager = new AgentProfileManager(plugin);
      await manager.load();
      const profiles = manager.getProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe("Test Profile");
    });

    it("migrates legacy settings on first load", async () => {
      plugin = createMockPlugin({
        settings: {
          "core.claudeCommand": "/usr/local/bin/claude",
          "core.claudeExtraArgs": "--model sonnet",
          "core.copilotCommand": "/usr/local/bin/copilot",
          "core.copilotExtraArgs": "--verbose",
          "core.additionalAgentContext": "You are a helper for $title",
          "core.strandsCommand": "/usr/local/bin/strands",
        },
      });
      manager = new AgentProfileManager(plugin);
      await manager.load();
      const profiles = manager.getProfiles();

      const claude = profiles.find((p) => p.name === "Claude" && !p.useContext);
      expect(claude).toBeTruthy();
      expect(claude!.command).toBe("/usr/local/bin/claude");
      expect(claude!.arguments).toBe("--model sonnet");

      const claudeCtx = profiles.find((p) => p.name === "Claude (ctx)" && p.useContext);
      expect(claudeCtx).toBeTruthy();
      expect(claudeCtx!.contextPrompt).toBe("You are a helper for $title");

      const copilot = profiles.find((p) => p.name === "Copilot");
      expect(copilot).toBeTruthy();
      expect(copilot!.command).toBe("/usr/local/bin/copilot");
      expect(copilot!.arguments).toBe("--verbose");

      const strands = profiles.find((p) => p.name === "Strands");
      expect(strands).toBeTruthy();
      expect(strands!.command).toBe("/usr/local/bin/strands");
    });

    it("sets migrated flag after migration", async () => {
      await manager.load();
      const savedData = plugin._getData();
      expect(savedData.agentProfilesMigrated).toBe(true);
    });
  });

  describe("CRUD", () => {
    beforeEach(async () => {
      await manager.load();
    });

    it("adds a profile", async () => {
      const newProfile = createDefaultProfile({
        name: "Custom Agent",
        agentType: "strands",
        sortOrder: 10,
      });
      await manager.addProfile(newProfile);
      const profiles = manager.getProfiles();
      expect(profiles.find((p) => p.name === "Custom Agent")).toBeTruthy();
    });

    it("updates a profile", async () => {
      const profiles = manager.getProfiles();
      const first = profiles[0];
      await manager.updateProfile(first.id, { name: "Renamed" });
      expect(manager.getProfile(first.id)?.name).toBe("Renamed");
    });

    it("deletes a profile", async () => {
      const profiles = manager.getProfiles();
      const initialCount = profiles.length;
      await manager.deleteProfile(profiles[0].id);
      expect(manager.getProfiles().length).toBe(initialCount - 1);
    });

    it("reorders profiles", async () => {
      const profiles = manager.getProfiles();
      const reversed = [...profiles].reverse().map((p) => p.id);
      await manager.reorderProfiles(reversed);
      const reordered = manager.getProfiles();
      expect(reordered[0].id).toBe(reversed[0]);
    });

    it("getButtonProfiles returns only enabled buttons", async () => {
      const buttons = manager.getButtonProfiles();
      expect(buttons.every((p) => p.button.enabled)).toBe(true);
    });

    it("getProfilesByType filters correctly", async () => {
      const claudeProfiles = manager.getProfilesByType("claude");
      expect(claudeProfiles.every((p) => p.agentType === "claude")).toBe(true);
    });
  });

  describe("import/export", () => {
    beforeEach(async () => {
      await manager.load();
    });

    it("exports profiles as JSON", () => {
      const json = manager.exportProfiles();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it("imports valid profiles", async () => {
      const toImport = [createDefaultProfile({ name: "Imported Agent", sortOrder: 0 })];
      const result = await manager.importProfiles(JSON.stringify(toImport));
      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(manager.getProfiles().find((p) => p.name === "Imported Agent")).toBeTruthy();
    });

    it("rejects invalid JSON", async () => {
      const result = await manager.importProfiles("not json");
      expect(result.imported).toBe(0);
      expect(result.errors).toContain("Invalid JSON");
    });

    it("rejects invalid profile schema", async () => {
      const result = await manager.importProfiles('[{"name": "missing fields"}]');
      expect(result.imported).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("assigns new IDs to imported profiles", async () => {
      const toImport = [createDefaultProfile({ name: "Import Test", sortOrder: 0 })];
      const originalId = toImport[0].id;
      await manager.importProfiles(JSON.stringify(toImport));
      const imported = manager.getProfiles().find((p) => p.name === "Import Test");
      expect(imported).toBeTruthy();
      expect(imported!.id).not.toBe(originalId);
    });
  });

  describe("resolve helpers", () => {
    beforeEach(async () => {
      await manager.load();
    });

    it("resolves command from profile when set", () => {
      const profile = createDefaultProfile({ command: "/custom/claude", agentType: "claude" });
      const result = manager.resolveCommand(profile, {});
      expect(result).toBe("/custom/claude");
    });

    it("falls back to global setting when profile command is empty", () => {
      const profile = createDefaultProfile({ command: "", agentType: "claude" });
      const result = manager.resolveCommand(profile, { "core.claudeCommand": "global-claude" });
      expect(result).toBe("global-claude");
    });

    it("resolves CWD from profile when set", () => {
      const profile = createDefaultProfile({ defaultCwd: "/custom/cwd" });
      const result = manager.resolveCwd(profile, {});
      expect(result).toBe("/custom/cwd");
    });

    it("falls back to global CWD", () => {
      const profile = createDefaultProfile({ defaultCwd: "" });
      const result = manager.resolveCwd(profile, { "core.defaultTerminalCwd": "/global/cwd" });
      expect(result).toBe("/global/cwd");
    });

    it("merges global and profile arguments", () => {
      const profile = createDefaultProfile({
        arguments: "--profile-flag",
        agentType: "claude",
      });
      const result = manager.resolveArguments(profile, { "core.claudeExtraArgs": "--global-flag" });
      expect(result).toBe("--global-flag --profile-flag");
    });

    it("resolves context prompt from profile when set", () => {
      const profile = createDefaultProfile({ contextPrompt: "Custom context" });
      const result = manager.resolveContextPrompt(profile, {});
      expect(result).toBe("Custom context");
    });

    it("falls back to global context", () => {
      const profile = createDefaultProfile({ contextPrompt: "" });
      const result = manager.resolveContextPrompt(profile, {
        "core.additionalAgentContext": "Global context",
      });
      expect(result).toBe("Global context");
    });

    it("resolveArguments merges global args exactly once", () => {
      const profile = createDefaultProfile({
        arguments: "--profile-arg",
        agentType: "claude",
      });
      const result = manager.resolveArguments(profile, {
        "core.claudeExtraArgs": "--global-arg",
      });
      // Global args should appear exactly once
      expect(result).toBe("--global-arg --profile-arg");
      expect(result.match(/--global-arg/g)?.length).toBe(1);
    });

    it("resolves command for each agent type", () => {
      for (const [agentType, settingKey, fallback] of [
        ["claude", "core.claudeCommand", "claude"],
        ["copilot", "core.copilotCommand", "copilot"],
        ["strands", "core.strandsCommand", "strands"],
      ] as const) {
        // Profile command takes priority
        const withCmd = createDefaultProfile({ command: "/custom/bin", agentType });
        expect(manager.resolveCommand(withCmd, {})).toBe("/custom/bin");
        // Falls back to global setting
        const withoutCmd = createDefaultProfile({ command: "", agentType });
        expect(manager.resolveCommand(withoutCmd, { [settingKey]: "global-cmd" })).toBe(
          "global-cmd",
        );
      }
    });
  });

  describe("load validation", () => {
    it("falls back to built-in defaults when stored profiles are invalid", async () => {
      plugin = createMockPlugin({
        agentProfiles: [{ invalid: "data" }],
      });
      manager = new AgentProfileManager(plugin);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.load();
      const profiles = manager.getProfiles();
      // Should have fallen back to built-in defaults
      expect(profiles.find((p) => p.name === "Claude")).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed validation"),
        expect.anything(),
      );
      warnSpy.mockRestore();
    });

    it("accepts valid stored profiles", async () => {
      const existing = [createDefaultProfile({ name: "Valid Profile", sortOrder: 0 })];
      plugin = createMockPlugin({ agentProfiles: existing });
      manager = new AgentProfileManager(plugin);
      await manager.load();
      expect(manager.getProfiles()).toHaveLength(1);
      expect(manager.getProfiles()[0].name).toBe("Valid Profile");
    });

    it("does NOT call saveData when stored profiles fail validation", async () => {
      plugin = createMockPlugin({
        agentProfiles: [{ id: "bad", agentType: "not-a-real-type" }],
        agentProfilesMigrated: true,
      });
      manager = new AgentProfileManager(plugin);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.load();
      expect(plugin.saveData).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("does NOT call saveData when migrated flag is set but profiles are absent", async () => {
      plugin = createMockPlugin({
        agentProfilesMigrated: true,
        // No agentProfiles key
      });
      manager = new AgentProfileManager(plugin);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.load();

      // Uses built-in defaults in-memory
      expect(manager.getProfiles().find((p) => p.name === "Claude")).toBeTruthy();
      // Does NOT write to disk
      expect(plugin.saveData).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("fills in defaults for profiles saved without newer fields", async () => {
      plugin = createMockPlugin({
        agentProfiles: [
          {
            id: "old-1",
            name: "Legacy Profile",
            agentType: "claude",
            // Missing: command, defaultCwd, arguments, contextPrompt, useContext,
            //          paramPassMode, button, sortOrder
          },
        ],
        agentProfilesMigrated: true,
      });
      manager = new AgentProfileManager(plugin);
      await manager.load();
      const profile = manager.getProfiles()[0];
      expect(profile.name).toBe("Legacy Profile");
      expect(profile.command).toBe("");
      expect(profile.defaultCwd).toBe("");
      expect(profile.useContext).toBe(false);
      expect(profile.paramPassMode).toBe("launch-only");
      expect(profile.sortOrder).toBe(0);
      expect(plugin.saveData).not.toHaveBeenCalled();
    });
  });
});
