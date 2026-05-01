import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const stylesPath = path.join(repoRoot, "styles.css");

function readRule(styles: string, selector: string): string | undefined {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`))?.[1];
}

describe("session filter styles", () => {
  it("centers the active sessions filter label and balances row spacing", async () => {
    const styles = await fs.readFile(stylesPath, "utf8");
    const rowRule = readRule(styles, ".wt-session-filter");
    const labelRule = readRule(styles, ".wt-session-filter-label");

    expect(rowRule).toBeDefined();
    expect(rowRule).toMatch(/display:\s*flex;/);
    expect(rowRule).toMatch(/align-items:\s*center;/);
    expect(rowRule).toMatch(/margin-top:\s*6px;/);

    expect(labelRule).toBeDefined();
    expect(labelRule).toMatch(/display:\s*inline-flex;/);
    expect(labelRule).toMatch(/align-items:\s*center;/);
    expect(labelRule).toMatch(/gap:\s*6px;/);
    expect(labelRule).toMatch(/line-height:\s*1\.4;/);
  });
});
