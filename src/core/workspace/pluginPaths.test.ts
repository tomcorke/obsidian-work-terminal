import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { resolvePluginDir } from "./pluginPaths";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe("resolvePluginDir", () => {
  it("normalizes a relative vault base path before resolving the plugin directory", () => {
    process.env.HOME = "/home/example";
    const app = { vault: { adapter: { basePath: "Vault" } } } as any;

    expect(resolvePluginDir(app, { id: "work-terminal" })).toBe(
      path.resolve("/home/example", "Vault", ".obsidian/plugins/work-terminal"),
    );
  });

  it("resolves tilde and getBasePath-only vault locations", () => {
    process.env.HOME = "/home/example";
    const tildeApp = { vault: { adapter: { basePath: "~/Vault" } } } as any;
    const getterApp = { vault: { adapter: { getBasePath: () => "OtherVault" } } } as any;

    expect(resolvePluginDir(tildeApp, { id: "work-terminal" })).toBe(
      path.resolve("/home/example/Vault/.obsidian/plugins/work-terminal"),
    );
    expect(resolvePluginDir(getterApp, { id: "work-terminal" })).toBe(
      path.resolve("/home/example/OtherVault/.obsidian/plugins/work-terminal"),
    );
  });

  it("resolves a relative manifest directory from cwd when the vault base is empty", () => {
    process.env.HOME = "";
    process.env.USERPROFILE = "";
    const app = { vault: { adapter: { basePath: "" } } } as any;

    expect(resolvePluginDir(app, { id: "work-terminal" })).toBe(
      path.resolve(".obsidian/plugins/work-terminal"),
    );
  });

  it("keeps an absolute manifest directory unchanged", () => {
    const app = { vault: { adapter: { basePath: "/ignored" } } } as any;

    expect(resolvePluginDir(app, { id: "work-terminal", dir: "/plugins/work-terminal" })).toBe(
      "/plugins/work-terminal",
    );
  });
});
