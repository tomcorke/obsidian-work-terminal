/**
 * ProfileFileStore - standalone JSON file storage for agent profiles.
 *
 * Profiles live in their own file outside the plugin data blob so they can be
 * hand-edited, bulk-edited, backed up, and version-controlled without touching
 * unrelated plugin state. The file is shared across vaults.
 */
import { electronRequire, expandTilde } from "../utils";

export const DEFAULT_PROFILES_PATH = "~/.config/obsidian-work-terminal/profiles.json";

export interface ProfileFileStore {
  /** Resolved absolute path, shown in the profile manager UI. */
  readonly path: string;
  /**
   * Parsed file contents, or `null` when the file is missing or empty.
   * Throws when the file exists but cannot be read or is not a JSON array.
   */
  read(): Promise<unknown[] | null>;
  write(profiles: unknown[]): Promise<void>;
}

export function createProfileFileStore(rawPath: string = DEFAULT_PROFILES_PATH): ProfileFileStore {
  const resolved = expandTilde(rawPath.trim() || DEFAULT_PROFILES_PATH);

  return {
    path: resolved,

    async read(): Promise<unknown[] | null> {
      const fs = electronRequire("fs") as typeof import("fs");
      let raw: string;
      try {
        raw = await fs.promises.readFile(resolved, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`${resolved} does not contain a JSON array of profiles`);
      }
      return parsed;
    },

    async write(profiles: unknown[]): Promise<void> {
      const fs = electronRequire("fs") as typeof import("fs");
      const path = electronRequire("path") as typeof import("path");
      const temp = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      try {
        await fs.promises.writeFile(temp, `${JSON.stringify(profiles, null, 2)}\n`, "utf-8");
        await fs.promises.rename(temp, resolved);
      } finally {
        await fs.promises.rm(temp, { force: true });
      }
    },
  };
}
