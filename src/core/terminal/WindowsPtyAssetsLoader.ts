import { electronRequire } from "../utils";
import { WINDOWS_PTY_ASSETS } from "./WindowsPtyAssets";

let prepared = false;

export function ensureWindowsPtyAssets(assetRoot?: string): string {
  const root = assetRoot || __dirname;
  if (prepared || process.platform !== "win32") return root;

  const architecture = `win32-${process.arch}`;
  const prefix = `prebuilds/${architecture}/`;
  const assets = WINDOWS_PTY_ASSETS.filter(
    (asset) => asset.path.startsWith(prefix) || !asset.path.startsWith("prebuilds/"),
  );
  if (!assets.some((asset) => asset.path.startsWith(prefix))) {
    throw new Error(`No bundled node-pty assets are available for ${architecture}`);
  }

  const fs = electronRequire("fs") as typeof import("fs");
  const path = electronRequire("path") as typeof import("path");
  let assetPath = "";
  let destination = "";
  try {
    for (const asset of assets) {
      assetPath = asset.path;
      destination = path.join(root, asset.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const contents = Buffer.from(asset.base64, "base64");
      try {
        if (
          fs.existsSync(destination) &&
          Buffer.compare(fs.readFileSync(destination), contents) === 0
        ) {
          continue;
        }
      } catch {
        // Write below and preserve the useful filesystem error if it fails.
      }
      fs.writeFileSync(destination, contents);
    }
    prepared = true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot prepare the bundled Windows terminal backend: ${detail} ` +
        `(root=${root}, asset=${assetPath}, destination=${destination})`,
    );
  }
  return root;
}
