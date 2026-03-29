const path = require("node:path");
const {
  ensureIsolatedVault,
  launchObsidian,
  parseIsolatedInstanceArgs,
  runCdpCommand,
  waitForDebugger,
} = require("./lib/obsidianAutomation");

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const config = parseIsolatedInstanceArgs(process.argv.slice(2), repoRoot);
  const pluginDir = config.pluginDir || repoRoot;
  const vaultInfo = await ensureIsolatedVault({
    vaultDir: config.vaultDir,
    pluginDir,
    clean: config.clean,
    sampleData: config.sampleData,
  });

  if (config.command === "init") {
    console.log(JSON.stringify({
      vaultDir: vaultInfo.vaultDir,
      pluginLinkPath: vaultInfo.pluginLinkPath,
    }, null, 2));
    return;
  }

  if (config.command === "status") {
    console.log(JSON.stringify({
      vaultDir: vaultInfo.vaultDir,
      pluginDir: pluginDir,
      pluginLinkPath: vaultInfo.pluginLinkPath,
      port: config.port,
    }, null, 2));
    return;
  }

  await launchObsidian({ vaultDir: vaultInfo.vaultDir, port: config.port });
  await waitForDebugger({ host: config.host, port: config.port, timeoutMs: config.timeoutMs });

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
