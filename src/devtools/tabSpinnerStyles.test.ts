import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const stylesPath = path.join(repoRoot, "styles.css");

describe("tab spinner styles", () => {
  it("keeps the active tab mask opaque on hover", async () => {
    const styles = await fs.readFile(stylesPath, "utf8");
    const hoverRuleIndex = styles.indexOf(".wt-tab:hover");
    const activeHoverRuleIndex = styles.indexOf(".wt-tab.wt-tab-agent-active:hover");

    expect(styles).toMatch(/\.wt-tab:hover\s*\{\s*--wt-tab-fill: var\(--background-modifier-hover\);\s*\}/);
    expect(styles).toMatch(
      /\.wt-tab\.wt-tab-agent-active:hover\s*\{\s*--wt-tab-fill: var\(--background-secondary\);\s*\}/,
    );
    expect(styles).toMatch(
      /\.wt-tab-agent-active::after\s*\{[\s\S]*background: var\(--wt-tab-fill, var\(--background-secondary\)\);/,
    );
    expect(hoverRuleIndex).toBeGreaterThanOrEqual(0);
    expect(activeHoverRuleIndex).toBeGreaterThan(hoverRuleIndex);
  });
});
