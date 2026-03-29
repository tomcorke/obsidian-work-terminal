const path = require("node:path");
const {
  assertDebuggerPortAvailable,
  ensureIsolatedVault,
  inspectIsolatedVault,
  launchObsidian,
  parseIsolatedInstanceArgs,
  runCdpCommand,
  verifyObsidianVault,
  waitForDebugger,
} = require("./lib/obsidianAutomation");

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const managedVaultDir = path.join(repoRoot, ".claude", "testing", "obsidian-vault");
  const config = parseIsolatedInstanceArgs(process.argv.slice(2), repoRoot);
  const pluginDir = config.pluginDir || repoRoot;
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

  const vaultInfo = await ensureIsolatedVault({
    vaultDir: config.vaultDir,
    pluginDir,
    clean: config.clean,
    sampleData: config.sampleData,
    force: config.force,
    managedVaultDir,
  });

  if (config.command === "init") {
    console.log(JSON.stringify({
      vaultDir: vaultInfo.vaultDir,
      pluginLinkPath: vaultInfo.pluginLinkPath,
    }, null, 2));
    return;
  }

  await assertDebuggerPortAvailable({ host: config.host, port: config.port, timeoutMs: config.timeoutMs });
  await launchObsidian({ vaultDir: vaultInfo.vaultDir, port: config.port });
  await waitForDebugger({ host: config.host, port: config.port, timeoutMs: config.timeoutMs });
  await verifyObsidianVault({
    host: config.host,
    port: config.port,
    timeoutMs: config.timeoutMs,
    expectedVaultDir: vaultInfo.vaultDir,
  });

  if (config.openView) {
    await runCdpCommand({
      command: "open-view",
      host: config.host,
      port: config.port,
      timeoutMs: config.timeoutMs,
    });
  }

  console.log(JSON.stringify({
    vaultDir: vaultInfo.vaultDir,
    port: config.port,
    openedView: config.openView,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
