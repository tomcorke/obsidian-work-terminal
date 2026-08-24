import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProfileFileStore, DEFAULT_PROFILES_PATH } from "./ProfileFileStore";
import { expandTilde } from "../utils";

describe("ProfileFileStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-profiles-"));
    file = path.join(dir, "nested", "profiles.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    expect(await createProfileFileStore(file).read()).toBeNull();
  });

  it("creates parent directories and round-trips profiles", async () => {
    const store = createProfileFileStore(file);
    await store.write([{ id: "a", name: "A" }]);
    expect(await store.read()).toEqual([{ id: "a", name: "A" }]);
    // Pretty-printed and newline-terminated so hand edits and diffs stay readable
    expect(fs.readFileSync(file, "utf-8")).toBe(
      '[\n  {\n    "id": "a",\n    "name": "A"\n  }\n]\n',
    );
  });

  it("treats an empty file as absent", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "  \n", "utf-8");
    expect(await createProfileFileStore(file).read()).toBeNull();
  });

  it("throws on invalid JSON", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json", "utf-8");
    await expect(createProfileFileStore(file).read()).rejects.toThrow();
  });

  it("throws when the file is not a JSON array", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"agentProfiles": []}', "utf-8");
    await expect(createProfileFileStore(file).read()).rejects.toThrow(
      "does not contain a JSON array",
    );
  });

  it("expands tilde paths and defaults when given a blank path", () => {
    expect(createProfileFileStore("~/wt/profiles.json").path).toBe(
      expandTilde("~/wt/profiles.json"),
    );
    expect(createProfileFileStore("  ").path).toBe(expandTilde(DEFAULT_PROFILES_PATH));
  });
});
