import { electronRequire } from "../utils";
import { WINDOWS_PTY_ASSETS } from "./WindowsPtyAssets";

let prepared = false;

export function ensureWindowsPtyAssets(): void {
  if (prepared || process.platform !== "win32") return;

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
  try {
    for (const asset of assets) {
      const destination = path.join(__dirname, asset.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(asset.base64, "base64"));
    }
    prepared = true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot prepare the bundled Windows terminal backend: ${detail}`);
  }
}
