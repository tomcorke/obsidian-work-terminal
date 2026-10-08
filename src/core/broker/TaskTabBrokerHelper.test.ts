import { spawnSync } from "child_process";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("bundled task tab broker helper", () => {
  it("refuses to run when the authenticated caller context is absent", () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("WORK_TERMINAL_")) delete env[key];
    }

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "task-tab-broker.js"), "listTabs"],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("available only inside an opted-in Work Terminal agent tab");
    expect(result.stdout).toBe("");
  });
});
