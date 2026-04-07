import path from "node:path";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixturesRoot = path.join(repoRoot, ".claude", "test-fixtures", "obsidian-automation");

const automation = await import("../../scripts/lib/obsidianAutomation.js");

afterEach(async () => {
  vi.restoreAllMocks();
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
      automation.parseCdpArgs(
        ["app.workspace.getLeavesOfType('work-terminal-view').length"],
        repoRoot,
      ),
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

  it("parses running Obsidian processes and extracts debugger ports from both flag styles", () => {
    const processes = automation.parseObsidianProcessList(`
      101 /Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222
      202 /Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port 9333
      303 /Applications/Obsidian.app/Contents/MacOS/Obsidian
    `);

    expect(processes).toEqual([
      {
        pid: 101,
        command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222",
        port: 9222,
      },
      {
        pid: 202,
        command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port 9333",
        port: 9333,
      },
      {
        pid: 303,
        command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
        port: null,
      },
    ]);
  });

  it("blocks launch when another Obsidian process uses the same debug port", () => {
    expect(() =>
      automation.assertIsolatedLaunchSupported({
        port: 9222,
        runningProcesses: [
          {
            pid: 101,
            command:
              "/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222",
            port: 9222,
          },
        ],
      }),
    ).toThrow("already using debug port 9222");
  });

  it("allows launch when existing Obsidian uses a different debug port", () => {
    expect(() =>
      automation.assertIsolatedLaunchSupported({
        port: 9333,
        runningProcesses: [
          {
            pid: 101,
            command:
              "/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222",
            port: 9222,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("allows launch alongside Obsidian processes without a debug port", () => {
    expect(() =>
      automation.assertIsolatedLaunchSupported({
        port: 9333,
        runningProcesses: [
          {
            pid: 101,
            command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
            port: null,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("allows launch when no Obsidian process is present", () => {
    expect(() =>
      automation.assertIsolatedLaunchSupported({
        port: 9333,
        runningProcesses: [],
      }),
    ).not.toThrow();
  });

  it("rejects missing values for path flags", () => {
    expect(() => automation.parseIsolatedInstanceArgs(["open", "--vault"], repoRoot)).toThrow(
      "--vault requires a value",
    );
    expect(() =>
      automation.parseIsolatedInstanceArgs(["open", "--vault", "--clean"], repoRoot),
    ).toThrow("--vault requires a value");
    expect(() => automation.parseIsolatedInstanceArgs(["open", "--plugin-dir"], repoRoot)).toThrow(
      "--plugin-dir requires a value",
    );
    expect(() =>
      automation.parseIsolatedInstanceArgs(["open", "--plugin-dir", "--no-open-view"], repoRoot),
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
    const pluginLinkTarget = await fs.readlink(
      path.join(vaultDir, ".obsidian", "plugins", "work-terminal"),
    );
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

    const pluginLinkTarget = await fs.readlink(
      path.join(vaultDir, ".obsidian", "plugins", "work-terminal"),
    );
    expect(
      path.resolve(
        path.dirname(path.join(vaultDir, ".obsidian", "plugins", "work-terminal")),
        pluginLinkTarget,
      ),
    ).toBe(pluginDir);
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

    await expect(fs.access(path.join(vaultDir, ".obsidian"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(path.join(vaultDir, ".work-terminal-test-vault.json")),
    ).rejects.toMatchObject({
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
    await fs.writeFile(
      path.join(otherPluginDir, "manifest.json"),
      '{"id":"work-terminal"}\n',
      "utf8",
    );
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

  it("waits for an Obsidian page target instead of a browser-only target", async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (requestCount < 3) {
        res.end(
          JSON.stringify([
            {
              id: "browser-only",
              type: "browser",
              title: "Obsidian",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/browser-only",
            },
          ]),
        );
        return;
      }

      res.end(
        JSON.stringify([
          {
            id: "page-ready",
            type: "page",
            title: "Obsidian",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/page-ready",
          },
        ]),
      );
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

      const targets = await automation.waitForDebugger({
        host: "127.0.0.1",
        port: address.port,
        timeoutMs: 2_500,
      });

      expect(automation.findObsidianPageTarget(targets)).toMatchObject({
        id: "page-ready",
        type: "page",
      });
      expect(requestCount).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("retries vault verification until the Obsidian app is ready", async () => {
    const close = vi.fn();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(path.join(repoRoot, ".claude", "testing", "obsidian-vault"));
    vi.spyOn(automation.CDPClient, "connect").mockResolvedValue({
      evaluate,
      close,
    });

    await expect(
      automation.verifyObsidianVault({
        host: "127.0.0.1",
        port: 9333,
        timeoutMs: 1_500,
        expectedVaultDir: path.join(repoRoot, ".claude", "testing", "obsidian-vault"),
      }),
    ).resolves.toBe(path.join(repoRoot, ".claude", "testing", "obsidian-vault"));

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("retries vault verification when the page target is not ready yet", async () => {
    const close = vi.fn();
    const evaluate = vi
      .fn()
      .mockResolvedValue(path.join(repoRoot, ".claude", "testing", "obsidian-vault"));
    vi.spyOn(automation.CDPClient, "connect")
      .mockRejectedValueOnce(new Error("No Obsidian page target found on 127.0.0.1:9333"))
      .mockResolvedValueOnce({
        evaluate,
        close,
      });

    await expect(
      automation.verifyObsidianVault({
        host: "127.0.0.1",
        port: 9333,
        timeoutMs: 1_500,
        expectedVaultDir: path.join(repoRoot, ".claude", "testing", "obsidian-vault"),
      }),
    ).resolves.toBe(path.join(repoRoot, ".claude", "testing", "obsidian-vault"));

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("open-view succeeds only after the work terminal leaf is present", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(1);
    const close = vi.fn();
    vi.spyOn(automation.CDPClient, "connect").mockResolvedValue({
      evaluate,
      close,
    });

    await expect(
      automation.runCdpCommand({
        command: "open-view",
        host: "127.0.0.1",
        port: 9222,
        timeoutMs: 1500,
      }),
    ).resolves.toBe("Work Terminal view opened");

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0][0]).toContain(
      'const commandId = "work-terminal:open-work-terminal"',
    );
    expect(evaluate.mock.calls[0][0]).toContain(
      'throw new Error("Obsidian command API is unavailable")',
    );
    expect(evaluate.mock.calls[1][0]).toContain(
      "globalThis.app?.workspace?.getLeavesOfType?.(viewType) ?? []",
    );
    expect(evaluate.mock.calls[1][0]).toContain('const viewType = "work-terminal-view"');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("open-view fails when the work terminal leaf never appears", async () => {
    const timeoutError = new Error("Timed out waiting for workspace leaf: work-terminal-view");
    const evaluate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(timeoutError);
    const close = vi.fn();
    vi.spyOn(automation.CDPClient, "connect").mockResolvedValue({
      evaluate,
      close,
    });

    await expect(
      automation.runCdpCommand({
        command: "open-view",
        host: "127.0.0.1",
        port: 9222,
        timeoutMs: 1500,
      }),
    ).rejects.toThrow("Timed out waiting for workspace leaf: work-terminal-view");

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("parses --no-hide flag in isolated-instance args", () => {
    const parsed = automation.parseIsolatedInstanceArgs(["open", "--no-hide"], repoRoot);
    expect(parsed.hide).toBe(false);
  });

  it("defaults hide to true in isolated-instance args", () => {
    const parsed = automation.parseIsolatedInstanceArgs(["open"], repoRoot);
    expect(parsed.hide).toBe(true);
  });

  it("parses stop command in isolated-instance args", () => {
    const parsed = automation.parseIsolatedInstanceArgs(["stop"], repoRoot);
    expect(parsed.command).toBe("stop");
  });

  it("findAvailablePort returns a port in the isolated range", async () => {
    const port = await automation.findAvailablePort({ host: "127.0.0.1" });
    expect(port).toBeGreaterThanOrEqual(automation.ISOLATED_PORT_BASE);
    expect(port).toBeLessThan(automation.ISOLATED_PORT_BASE + automation.ISOLATED_PORT_RANGE);
  });

  it("findAvailablePort skips an occupied port", async () => {
    // Occupy a specific port in the isolated range
    const occupiedPort = automation.ISOLATED_PORT_BASE;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(occupiedPort, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    try {
      const port = await automation.findAvailablePort({ host: "127.0.0.1" });
      expect(port).toBeGreaterThanOrEqual(automation.ISOLATED_PORT_BASE);
      expect(port).toBeLessThan(automation.ISOLATED_PORT_BASE + automation.ISOLATED_PORT_RANGE);
      expect(port).not.toBe(occupiedPort);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err: Error | undefined) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("hideObsidianWindow calls CDP evaluate with the hide expression", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(undefined);
    const close = vi.fn();
    vi.spyOn(automation.CDPClient, "connect").mockResolvedValue({
      evaluate,
      close,
    });

    await automation.hideObsidianWindow({ host: "127.0.0.1", port: 9333 });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0]).toContain("getCurrentWindow().hide()");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("hideObsidianWindow closes the CDP client even on failure", async () => {
    const evaluate = vi.fn().mockRejectedValueOnce(new Error("no electron"));
    const close = vi.fn();
    vi.spyOn(automation.CDPClient, "connect").mockResolvedValue({
      evaluate,
      close,
    });

    await expect(automation.hideObsidianWindow({ host: "127.0.0.1", port: 9333 })).rejects.toThrow(
      "no electron",
    );

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("killIsolatedInstance requires userDataDir", async () => {
    await expect(automation.killIsolatedInstance({})).rejects.toThrow("userDataDir is required");
  });

  it("killIsolatedInstance matches processes by user-data-dir path", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string) => {
      killed.push({ pid, signal: signal || "SIGTERM" });
      // Simulate process exiting after SIGTERM (signal 0 check throws)
      if (signal === 0 || signal === undefined) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    }) as typeof process.kill);

    const runningProcesses = [
      {
        pid: 100,
        command:
          "/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9300 --user-data-dir=/tmp/vault-a/.user-data",
        port: 9300,
      },
      {
        pid: 200,
        command:
          "/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9301 --user-data-dir=/tmp/vault-b/.user-data",
        port: 9301,
      },
    ];

    const count = await automation.killIsolatedInstance({
      userDataDir: "/tmp/vault-a/.user-data",
      runningProcesses,
    });
    expect(count).toBe(1);
    // Should have sent SIGTERM then checked if still running (signal 0)
    expect(killed.some((k) => k.pid === 100 && k.signal === "SIGTERM")).toBe(true);
    expect(killed.every((k) => k.pid !== 200)).toBe(true);
  });

  it("exports OBSIDIAN_BINARY as a lazy getter matching current platform", () => {
    const binary = automation.OBSIDIAN_BINARY;
    expect(typeof binary).toBe("string");
    expect(binary.length).toBeGreaterThan(0);
    if (process.platform === "darwin") {
      expect(binary).toBe("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
    } else if (process.platform === "win32") {
      expect(binary).toMatch(/Obsidian\.exe$/);
    } else if (process.platform === "linux") {
      expect(binary).toMatch(/obsidian$/);
    }
  });

  it("OBSIDIAN_BINARY env var takes priority over platform detection", () => {
    const original = process.env.OBSIDIAN_BINARY;
    try {
      process.env.OBSIDIAN_BINARY = "/custom/path/to/obsidian";
      expect(automation.getDefaultObsidianBinary()).toBe("/custom/path/to/obsidian");
    } finally {
      if (original === undefined) {
        delete process.env.OBSIDIAN_BINARY;
      } else {
        process.env.OBSIDIAN_BINARY = original;
      }
    }
  });

  it("Linux detection returns the first existing candidate path", () => {
    const originalPlatform = process.platform;
    const originalEnv = process.env.OBSIDIAN_BINARY;
    try {
      delete process.env.OBSIDIAN_BINARY;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      // Mock existsSync to say only /opt/Obsidian/obsidian exists
      const existsSyncSpy = vi
        .spyOn(require("node:fs"), "existsSync")
        .mockImplementation((p: string) => {
          return p === "/opt/Obsidian/obsidian";
        });

      expect(automation.getDefaultObsidianBinary()).toBe("/opt/Obsidian/obsidian");

      existsSyncSpy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv === undefined) {
        delete process.env.OBSIDIAN_BINARY;
      } else {
        process.env.OBSIDIAN_BINARY = originalEnv;
      }
    }
  });

  it("Linux detection throws when no candidate path exists", () => {
    const originalPlatform = process.platform;
    const originalEnv = process.env.OBSIDIAN_BINARY;
    try {
      delete process.env.OBSIDIAN_BINARY;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      const existsSyncSpy = vi.spyOn(require("node:fs"), "existsSync").mockReturnValue(false);

      expect(() => automation.getDefaultObsidianBinary()).toThrow(
        "Obsidian binary not found in any standard Linux location",
      );

      existsSyncSpy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv === undefined) {
        delete process.env.OBSIDIAN_BINARY;
      } else {
        process.env.OBSIDIAN_BINARY = originalEnv;
      }
    }
  });

  it("unsupported platform throws a descriptive error", () => {
    const originalPlatform = process.platform;
    const originalEnv = process.env.OBSIDIAN_BINARY;
    try {
      delete process.env.OBSIDIAN_BINARY;
      Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });

      expect(() => automation.getDefaultObsidianBinary()).toThrow('Unsupported platform "freebsd"');
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv === undefined) {
        delete process.env.OBSIDIAN_BINARY;
      } else {
        process.env.OBSIDIAN_BINARY = originalEnv;
      }
    }
  });

  it("seedUserDataDir creates obsidian.json with vault config", async () => {
    const userDataDir = path.join(fixturesRoot, "user-data");
    const vaultDir = path.join(fixturesRoot, "vault");

    await automation.seedUserDataDir({ userDataDir, vaultDir });

    const obsidianJson = JSON.parse(
      await fs.readFile(path.join(userDataDir, "obsidian.json"), "utf8"),
    );
    const vaultIds = Object.keys(obsidianJson.vaults);
    expect(vaultIds).toHaveLength(1);
    const vaultEntry = obsidianJson.vaults[vaultIds[0]];
    expect(vaultEntry.path).toBe(path.resolve(vaultDir));
    expect(vaultEntry.open).toBe(true);
    expect(typeof vaultEntry.ts).toBe("number");
  });

  it("seedUserDataDir generates stable vault IDs for the same path", async () => {
    const userDataDir = path.join(fixturesRoot, "user-data");
    const vaultDir = path.join(fixturesRoot, "vault");

    await automation.seedUserDataDir({ userDataDir, vaultDir });
    const first = JSON.parse(await fs.readFile(path.join(userDataDir, "obsidian.json"), "utf8"));
    const firstId = Object.keys(first.vaults)[0];

    await automation.seedUserDataDir({ userDataDir, vaultDir });
    const second = JSON.parse(await fs.readFile(path.join(userDataDir, "obsidian.json"), "utf8"));
    const secondId = Object.keys(second.vaults)[0];

    expect(firstId).toBe(secondId);
  });
});
