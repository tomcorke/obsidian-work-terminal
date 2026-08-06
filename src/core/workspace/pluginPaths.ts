import type { App } from "obsidian";
import { electronRequire, expandTilde } from "../utils";

export function resolveVaultBasePath(app: App): string {
  const path = electronRequire("path") as typeof import("path");
  const adapter = (app as any)?.vault?.adapter;
  let vaultPath = expandTilde(adapter?.basePath || adapter?.getBasePath?.() || "");
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";

  if (vaultPath && !path.isAbsolute(vaultPath)) {
    vaultPath = homeDir ? path.resolve(homeDir, vaultPath) : path.resolve(vaultPath);
  }

  return vaultPath;
}

export function resolvePluginDir(app: App, manifest: { id: string; dir?: string }): string {
  const path = electronRequire("path") as typeof import("path");
  const manifestDir = manifest.dir || `.obsidian/plugins/${manifest.id}`;
  if (path.isAbsolute(manifestDir)) return manifestDir;

  const vaultBasePath = resolveVaultBasePath(app);
  return vaultBasePath ? path.resolve(vaultBasePath, manifestDir) : path.resolve(manifestDir);
}
