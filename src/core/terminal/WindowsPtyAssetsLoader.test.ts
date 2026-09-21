import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./WindowsPtyAssets", () => ({
  WINDOWS_PTY_ASSETS: [
    { path: "prebuilds/win32-x64/conpty.node", base64: Buffer.from("native").toString("base64") },
    { path: "shared/conout.js", base64: Buffer.from("shared").toString("base64") },
    { path: "node-pty-helper.cjs", base64: Buffer.from("helper").toString("base64") },
  ],
}));

import { ensureWindowsPtyAssets } from "./WindowsPtyAssetsLoader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ensureWindowsPtyAssets", () => {
  it("extracts assets under the supplied plugin directory", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = mkdtempSync(join(tmpdir(), "work-terminal-pty-"));
    roots.push(root);

    expect(ensureWindowsPtyAssets(root)).toBe(root);
    expect(readFileSync(join(root, "prebuilds/win32-x64/conpty.node"), "utf8")).toBe("native");
    expect(readFileSync(join(root, "shared/conout.js"), "utf8")).toBe("shared");
    expect(readFileSync(join(root, "node-pty-helper.cjs"), "utf8")).toBe("helper");
  });
});
