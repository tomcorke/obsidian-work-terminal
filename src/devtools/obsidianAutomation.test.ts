import path from "node:path";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
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

  it("rejects missing values for path flags", () => {
    expect(() => automation.parseIsolatedInstanceArgs(["open", "--vault"], repoRoot)).toThrow(
      "--vault requires a value",
    );
    expect(() => automation.parseIsolatedInstanceArgs(["open", "--vault", "--clean"], repoRoot)).toThrow(
      "--vault requires a value",
    );
    expect(() => automation.parseIsolatedInstanceArgs(["open", "--plugin-dir"], repoRoot)).toThrow(
      "--plugin-dir requires a value",
    );
    expect(
      () => automation.parseIsolatedInstanceArgs(["open", "--plugin-dir", "--no-open-view"], repoRoot),
    ).toThrow("--plugin-dir requires a value");
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

  it("does not scaffold anything during status inspection", async () => {
    const vaultDir = path.join(fixturesRoot, "missing-vault");

    const status = await automation.inspectIsolatedVault({ vaultDir });

    expect(status.exists).toBe(false);
    await expect(fs.access(vaultDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects clean on existing unmarked vaults by default", async () => {
    const pluginDir = path.join(fixturesRoot, "plugin");
    const vaultDir = path.join(fixturesRoot, "managed", "custom-vault");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");
    await fs.mkdir(vaultDir, { recursive: true });
    await fs.writeFile(path.join(vaultDir, "keep.txt"), "do not delete", "utf8");

    await expect(
      automation.ensureIsolatedVault({
        vaultDir,
        pluginDir,
        clean: true,
        sampleData: false,
        managedVaultDir: path.join(fixturesRoot, "managed", "obsidian-vault"),
      }),
    ).rejects.toThrow("Refusing to modify existing unmarked vault");
  });

  it("rejects adopting an existing unmarked vault without force", async () => {
    const pluginDir = path.join(fixturesRoot, "plugin");
    const vaultDir = path.join(fixturesRoot, "existing-vault");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");
    await fs.mkdir(vaultDir, { recursive: true });
    await fs.writeFile(path.join(vaultDir, "notes.md"), "# keep me\n", "utf8");

    await expect(
      automation.ensureIsolatedVault({
        vaultDir,
        pluginDir,
        sampleData: false,
        managedVaultDir: path.join(fixturesRoot, "managed", "obsidian-vault"),
      }),
    ).rejects.toThrow("Refusing to modify existing unmarked vault");

    await expect(fs.access(path.join(vaultDir, ".obsidian"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(vaultDir, ".work-terminal-test-vault.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects replacing an existing real plugin directory without force", async () => {
    const pluginDir = path.join(fixturesRoot, "plugin");
    const vaultDir = path.join(fixturesRoot, "vault");
    const existingPluginDir = path.join(vaultDir, ".obsidian", "plugins", "work-terminal");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(vaultDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");
    await fs.writeFile(
      path.join(vaultDir, ".work-terminal-test-vault.json"),
      '{"pluginId":"work-terminal","pluginDir":"old-plugin"}\n',
      "utf8",
    );
    await fs.mkdir(existingPluginDir, { recursive: true });
    await fs.writeFile(path.join(existingPluginDir, "marker.txt"), "keep", "utf8");

    await expect(
      automation.ensureIsolatedVault({
        vaultDir,
        pluginDir,
        sampleData: false,
      }),
    ).rejects.toThrow("Refusing to replace existing non-symlink path");
  });

  it("rejects repointing an existing plugin symlink without force", async () => {
    const pluginDir = path.join(fixturesRoot, "plugin");
    const otherPluginDir = path.join(fixturesRoot, "other-plugin");
    const vaultDir = path.join(fixturesRoot, "vault");
    const existingPluginLink = path.join(vaultDir, ".obsidian", "plugins", "work-terminal");

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(otherPluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");
    await fs.writeFile(path.join(otherPluginDir, "manifest.json"), '{"id":"work-terminal"}\n', "utf8");
    await fs.mkdir(path.dirname(existingPluginLink), { recursive: true });
    await fs.writeFile(
      path.join(vaultDir, ".work-terminal-test-vault.json"),
      '{"pluginId":"work-terminal","pluginDir":"old-plugin"}\n',
      "utf8",
    );
    await fs.symlink(otherPluginDir, existingPluginLink);

    await expect(
      automation.ensureIsolatedVault({
        vaultDir,
        pluginDir,
        sampleData: false,
      }),
    ).rejects.toThrow("Refusing to repoint existing symlink");
  });

  it("fails fast when the debugger port is already occupied", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }

      await expect(
        automation.assertDebuggerPortAvailable({
          host: "127.0.0.1",
          port: address.port,
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("already in use");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("treats reset connections as an occupied debugger port", async () => {
    const server = net.createServer((socket) => {
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }

      await expect(
        automation.assertDebuggerPortAvailable({
          host: "127.0.0.1",
          port: address.port,
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("already in use");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
