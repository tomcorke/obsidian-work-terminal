const path = require("node:path");
const { parseCdpArgs, runCdpCommand } = require("./scripts/lib/obsidianAutomation");

async function main() {
  const config = parseCdpArgs(process.argv.slice(2), process.cwd());
  const result = await runCdpCommand(config);

  if (typeof result === "string") {
    console.log(result);
    return;
  }

  if (result === undefined) {
    console.log("ok");
    return;
  }

  if (result && typeof result === "object" && result.outputPath) {
    const relativePath = path.relative(process.cwd(), result.outputPath) || result.outputPath;
    console.log(relativePath);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
