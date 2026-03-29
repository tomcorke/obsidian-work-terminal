import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixturesRoot = path.join(repoRoot, ".claude", "test-fixtures", "obsidian-automation");

const automation = await import("../../scripts/lib/obsidianAutomation.js");

afterEach(async () => {
  await fs.rm(fixturesRoot, { recursive: true, force: true });
});

describe("obsidian automation helpers", () => {
  it("parses the default CDP command as reload", () => {
    expect(automation.parseCdpArgs([], repoRoot)).toMatchObject({
      command: "reload",
      port: 9222,
    });
  });

  it("keeps bare expressions backward compatible", () => {
    expect(
      automation.parseCdpArgs(["app.workspace.getLeavesOfType('work-terminal-view').length"], repoRoot),
    ).toMatchObject({
      command: "eval",
      expression: "app.workspace.getLeavesOfType('work-terminal-view').length",
    });
  });

  it("parses screenshot arguments with selector and output path", () => {
    const parsed = automation.parseCdpArgs(
      ["screenshot", "output/check.png", "--selector", ".wt-main-layout", "--padding", "24"],
      repoRoot,
    );

    expect(parsed).toMatchObject({
      command: "screenshot",
      selector: ".wt-main-layout",
      selectorPadding: 24,
    });
    expect(parsed.outputPath).toBe(path.join(repoRoot, "output", "check.png"));
  });

  it("parses isolated-instance flags", () => {
    const parsed = automation.parseIsolatedInstanceArgs(
      ["open", "--vault", ".claude/custom-vault", "--port", "9555", "--clean", "--no-open-view"],
      repoRoot,
    );

    expect(parsed).toMatchObject({
      command: "open",
      clean: true,
      openView: false,
      port: 9555,
      vaultDir: path.join(repoRoot, ".claude", "custom-vault"),
    });
  });

  it("creates an isolated vault with plugin link and seed tasks", async () => {
    const pluginDir = path.join(fixturesRoot, "plugin");
    const vaultDir = path.join(fixturesRoot, "vault");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");

    const result = await automation.ensureIsolatedVault({
      vaultDir,
      pluginDir,
      clean: true,
      sampleData: true,
    });

    expect(result.vaultDir).toBe(vaultDir);
    const pluginLinkTarget = await fs.readlink(path.join(vaultDir, ".obsidian", "plugins", "work-terminal"));
    expect(path.resolve(path.dirname(result.pluginLinkPath), pluginLinkTarget)).toBe(pluginDir);

    const communityPlugins = JSON.parse(
      await fs.readFile(path.join(vaultDir, ".obsidian", "community-plugins.json"), "utf8"),
    );
    expect(communityPlugins).toEqual(["work-terminal"]);

    const activeTask = await fs.readFile(
      path.join(vaultDir, "2 - Areas", "Tasks", "active", "TASK-automation-smoke.md"),
      "utf8",
    );
    expect(activeTask).toContain("Automation smoke test");

    const todoTask = await fs.readFile(
      path.join(vaultDir, "2 - Areas", "Tasks", "todo", "TASK-screenshot-regression.md"),
      "utf8",
    );
    expect(todoTask).toContain("Screenshot regression capture");
  });

  it("reuses the existing plugin symlink on repeated init", async () => {
    const pluginDir = path.join(fixturesRoot, "plugin");
    const vaultDir = path.join(fixturesRoot, "vault");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");

    await automation.ensureIsolatedVault({
      vaultDir,
      pluginDir,
      clean: true,
      sampleData: false,
    });
    await automation.ensureIsolatedVault({
      vaultDir,
      pluginDir,
      clean: false,
      sampleData: false,
    });

    const pluginLinkTarget = await fs.readlink(path.join(vaultDir, ".obsidian", "plugins", "work-terminal"));
    expect(path.resolve(path.dirname(path.join(vaultDir, ".obsidian", "plugins", "work-terminal")), pluginLinkTarget)).toBe(
      pluginDir,
    );
  });
});
