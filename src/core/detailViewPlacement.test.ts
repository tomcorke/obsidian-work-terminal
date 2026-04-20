import { describe, it, expect } from "vitest";
import { DETAIL_VIEW_DEFAULTS, resolveDetailViewOptions } from "./detailViewPlacement";

describe("resolveDetailViewOptions", () => {
  it("returns defaults when settings are undefined", () => {
    const options = resolveDetailViewOptions(undefined);
    expect(options).toEqual(DETAIL_VIEW_DEFAULTS);
  });

  it("returns defaults for an empty settings object", () => {
    const options = resolveDetailViewOptions({});
    expect(options).toEqual(DETAIL_VIEW_DEFAULTS);
  });

  it("preserves backwards-compatible split defaults", () => {
    // Covers acceptance criterion: "Default is backwards-compatible (split mode)"
    expect(DETAIL_VIEW_DEFAULTS.placement).toBe("split");
    expect(DETAIL_VIEW_DEFAULTS.widthOverride).toBe(true);
    expect(DETAIL_VIEW_DEFAULTS.autoClose).toBe(false);
    expect(DETAIL_VIEW_DEFAULTS.splitDirection).toBe("vertical");
  });

  it("accepts each valid placement value", () => {
    for (const placement of ["split", "tab", "navigate", "disabled"] as const) {
      const options = resolveDetailViewOptions({
        "core.detailViewPlacement": placement,
      });
      expect(options.placement).toBe(placement);
    }
  });

  it("falls back to split for an unknown placement value", () => {
    const options = resolveDetailViewOptions({
      "core.detailViewPlacement": "bogus",
    });
    expect(options.placement).toBe("split");
  });

  it("falls back to split for a non-string placement value", () => {
    const options = resolveDetailViewOptions({
      "core.detailViewPlacement": 42,
    });
    expect(options.placement).toBe("split");
  });

  it("accepts both split directions", () => {
    for (const direction of ["vertical", "horizontal"] as const) {
      const options = resolveDetailViewOptions({
        "core.detailViewSplitDirection": direction,
      });
      expect(options.splitDirection).toBe(direction);
    }
  });

  it("falls back to vertical for an unknown split direction", () => {
    const options = resolveDetailViewOptions({
      "core.detailViewSplitDirection": "diagonal",
    });
    expect(options.splitDirection).toBe("vertical");
  });

  it("honours widthOverride when explicitly set", () => {
    const off = resolveDetailViewOptions({ "core.detailViewWidthOverride": false });
    expect(off.widthOverride).toBe(false);

    const on = resolveDetailViewOptions({ "core.detailViewWidthOverride": true });
    expect(on.widthOverride).toBe(true);
  });

  it("defaults widthOverride to true when value is not a boolean", () => {
    const options = resolveDetailViewOptions({
      "core.detailViewWidthOverride": "yes",
    });
    expect(options.widthOverride).toBe(true);
  });

  it("honours autoClose when explicitly set", () => {
    const on = resolveDetailViewOptions({ "core.detailViewAutoClose": true });
    expect(on.autoClose).toBe(true);

    const off = resolveDetailViewOptions({ "core.detailViewAutoClose": false });
    expect(off.autoClose).toBe(false);
  });

  it("defaults autoClose to false when value is not a boolean", () => {
    const options = resolveDetailViewOptions({
      "core.detailViewAutoClose": "true",
    });
    expect(options.autoClose).toBe(false);
  });

  it("combines all settings into a single options object", () => {
    const options = resolveDetailViewOptions({
      "core.detailViewPlacement": "tab",
      "core.detailViewSplitDirection": "horizontal",
      "core.detailViewWidthOverride": false,
      "core.detailViewAutoClose": true,
    });
    expect(options).toEqual({
      placement: "tab",
      splitDirection: "horizontal",
      widthOverride: false,
      autoClose: true,
    });
  });

  it("ignores unrelated settings", () => {
    const options = resolveDetailViewOptions({
      "core.defaultShell": "/bin/zsh",
      "core.viewMode": "kanban",
    });
    expect(options).toEqual(DETAIL_VIEW_DEFAULTS);
  });
});
