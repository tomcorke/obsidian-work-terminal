import { describe, expect, it, vi } from "vitest";
import { mergeAndSavePluginData } from "./PluginDataStore";

function createMockPlugin(initialData: Record<string, any> = {}) {
  let data = { ...initialData };
  return {
    loadData: vi.fn(async () => ({ ...data })),
    saveData: vi.fn(async (next: Record<string, any>) => {
      await Promise.resolve();
      data = next;
    }),
    getData: () => data,
  };
}

describe("mergeAndSavePluginData", () => {
  it("preserves unrelated keys across concurrent writes", async () => {
    const plugin = createMockPlugin();

    await Promise.all([
      mergeAndSavePluginData(plugin, async (data) => {
        await Promise.resolve();
        data.settings = { "core.defaultShell": "/bin/zsh" };
      }),
      mergeAndSavePluginData(plugin, async (data) => {
        data.customOrder = { todo: ["task-1"] };
      }),
      mergeAndSavePluginData(plugin, async (data) => {
        data.persistedSessions = [{ claudeSessionId: "session-1" }];
      }),
    ]);

    expect(plugin.getData()).toEqual({
      settings: { "core.defaultShell": "/bin/zsh" },
      customOrder: { todo: ["task-1"] },
      persistedSessions: [{ claudeSessionId: "session-1" }],
    });
  });

  it("continues processing queued writes after a failure", async () => {
    const plugin = createMockPlugin();

    await expect(
      mergeAndSavePluginData(plugin, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await mergeAndSavePluginData(plugin, async (data) => {
      data.settings = { foo: "bar" };
    });

    expect(plugin.getData()).toEqual({
      settings: { foo: "bar" },
    });
  });
});
