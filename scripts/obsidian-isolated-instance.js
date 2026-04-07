const path = require("node:path");
const {
  assertDebuggerPortAvailable,
  assertIsolatedLaunchSupported,
  dismissTrustDialog,
  ensureIsolatedVault,
  findAvailablePort,
  hideObsidianWindow,
  inspectIsolatedVault,
  killIsolatedInstance,
  launchObsidian,
  parseIsolatedInstanceArgs,
  runCdpCommand,
  seedUserDataDir,
  verifyObsidianVault,
  waitForDebugger,
} = require("./lib/obsidianAutomation");

/**
 * WARNING: The `open` command briefly steals user focus (~2-3 seconds) while
 * Obsidian starts up, before the window is hidden via CDP. This MUST NOT be
 * triggered automatically - only with explicit user consent for testing or
 * bug replication.
 *
 * For automated testing, prefer filesystem-based task manipulation combined
 * with CDP UI interaction over agent sessions. Agent sessions require VERY
 * EXPLICIT user approval.
 */
async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const managedVaultDir = path.join(repoRoot, ".claude", "testing", "obsidian-vault");
  const config = parseIsolatedInstanceArgs(process.argv.slice(2), repoRoot);
  const pluginDir = config.pluginDir || repoRoot;

  if (config.command === "stop") {
    const userDataDir = path.join(config.vaultDir, ".user-data");
    const killed = await killIsolatedInstance({ userDataDir });
    console.log(JSON.stringify({ stopped: killed, userDataDir }));
    return;
  }

  if (config.command === "open") {
    // Use automatic port selection unless --port was explicitly provided
    const portExplicit = process.argv.slice(2).some((a) => a === "--port");
    const port = portExplicit ? config.port : await findAvailablePort({ host: config.host });

    await assertDebuggerPortAvailable({ host: config.host, port, timeoutMs: config.timeoutMs });
    assertIsolatedLaunchSupported({ port });

    const vaultInfo = await ensureIsolatedVault({
      vaultDir: config.vaultDir,
      pluginDir,
      clean: config.clean,
      sampleData: config.sampleData,
      force: config.force,
      managedVaultDir,
    });

    // Use a per-vault user-data-dir so each isolated instance has its own
    // Electron profile, avoiding singleton conflicts with the main Obsidian.
    const userDataDir = path.join(vaultInfo.vaultDir, ".user-data");

    // Pre-seed the user-data-dir with vault config so Obsidian opens the
    // vault directly instead of showing the starter/vault-picker screen.
    await seedUserDataDir({ userDataDir, vaultDir: vaultInfo.vaultDir });

    const { pid } = await launchObsidian({
      vaultDir: vaultInfo.vaultDir,
      port,
      userDataDir,
    });
    await waitForDebugger({ host: config.host, port, timeoutMs: config.timeoutMs });
    await verifyObsidianVault({
      host: config.host,
      port,
      timeoutMs: config.timeoutMs,
      expectedVaultDir: vaultInfo.vaultDir,
    });

    // Dismiss the "Trust author" dialog on first launch so plugins load.
    await dismissTrustDialog({ host: config.host, port, timeoutMs: config.timeoutMs });

    if (config.hide) {
      // Wait briefly for Obsidian's startup sequence to finish (it re-shows
      // the window after initial load), then hide via CDP.
      await new Promise((r) => setTimeout(r, 1500));
      await hideObsidianWindow({ host: config.host, port, timeoutMs: config.timeoutMs });
    }

    if (config.openView) {
      await runCdpCommand({
        command: "open-view",
        host: config.host,
        port,
        timeoutMs: config.timeoutMs,
      });
    }

    console.log(JSON.stringify({
      vaultDir: vaultInfo.vaultDir,
      port,
      pid,
      userDataDir,
      hidden: config.hide,
      openedView: config.openView,
    }, null, 2));
    return;
  }

  if (config.command === "status") {
    const status = await inspectIsolatedVault({ vaultDir: config.vaultDir });
    console.log(JSON.stringify({
      vaultDir: status.vaultDir,
      pluginDir,
      pluginLinkPath: status.pluginLinkPath,
      pluginLinkType: status.pluginLinkType,
      pluginTarget: status.pluginTarget,
      exists: status.exists,
      managed: status.managed,
      port: config.port,
    }, null, 2));
    return;
  }

  // init command
  const vaultInfo = await ensureIsolatedVault({
    vaultDir: config.vaultDir,
    pluginDir,
    clean: config.clean,
    sampleData: config.sampleData,
    force: config.force,
    managedVaultDir,
  });

  console.log(JSON.stringify({
    vaultDir: vaultInfo.vaultDir,
    pluginLinkPath: vaultInfo.pluginLinkPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
