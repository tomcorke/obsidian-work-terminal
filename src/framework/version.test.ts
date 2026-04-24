/**
 * Unit coverage for the version formatters. Build-time injected constants
 * are covered by tests that pass explicit arguments rather than relying on
 * esbuild's substitution (which is undefined under vitest).
 */
import { describe, expect, it } from "vitest";
import {
  formatVersionTimestamp,
  formatVersionForSettings,
  formatVersionForTabTitle,
} from "./version";

describe("formatVersionTimestamp", () => {
  it("returns empty string for empty input", () => {
    expect(formatVersionTimestamp("")).toBe("");
  });

  it("returns empty string for unparsable input", () => {
    expect(formatVersionTimestamp("not-a-date")).toBe("");
  });

  it("returns a non-empty formatted string for a valid ISO timestamp", () => {
    const out = formatVersionTimestamp("2026-04-24T12:47:12+01:00");
    expect(out).not.toBe("");
    // Month name from `toLocaleString` with `month: "short"` should appear
    // in at least the en-GB/en-US locales used in CI.
    expect(out.length).toBeGreaterThan(5);
  });
});

describe("formatVersionForSettings", () => {
  it("includes a 'released' qualifier for tagged builds", () => {
    const out = formatVersionForSettings("0.5.0", true, "2026-04-24T12:47:12+01:00");
    expect(out).toMatch(/^0\.5\.0 \(released /);
  });

  it("includes a 'committed' qualifier for non-tagged builds", () => {
    const out = formatVersionForSettings("c072614", false, "2026-04-24T12:47:12+01:00");
    expect(out).toMatch(/^c072614 \(committed /);
  });

  it("omits the timestamp clause when the timestamp is empty", () => {
    expect(formatVersionForSettings("dev", false, "")).toBe("dev");
  });

  it("omits the timestamp clause when the timestamp is unparsable", () => {
    expect(formatVersionForSettings("0.5.0", true, "garbage")).toBe("0.5.0");
  });
});

describe("formatVersionForTabTitle", () => {
  it("returns an empty string when disabled (so callers can append unconditionally)", () => {
    expect(formatVersionForTabTitle(false, "0.5.0")).toBe("");
  });

  it("returns ` (version)` when enabled", () => {
    expect(formatVersionForTabTitle(true, "0.5.0")).toBe(" (0.5.0)");
  });

  it("handles a short SHA", () => {
    expect(formatVersionForTabTitle(true, "c072614")).toBe(" (c072614)");
  });

  it("returns empty when version is empty", () => {
    expect(formatVersionForTabTitle(true, "")).toBe("");
  });
});
