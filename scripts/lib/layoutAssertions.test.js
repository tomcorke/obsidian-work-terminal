/**
 * Unit tests for layoutAssertions.js - the generic sanity assertion helpers
 * used by the smoke test runner.
 *
 * These tests exercise the pure-function core of each check against mock
 * DOM trees. They do NOT launch Obsidian or a real browser; the smoke
 * runner is responsible for exercising the real DOM.
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  collectSanityViolations,
  findZeroSizeViolations,
  findClippedOverflowViolations,
  findOutOfBoundsViolations,
  buildSanityCheckCdpExpression,
} from "./layoutAssertions.js";

/**
 * Build a DOM tree inside jsdom and apply inline layout attributes via
 * `Object.defineProperty` so the pure functions see the values they would
 * see in a real browser (jsdom does not compute layout).
 */
function makeTree(html) {
  document.body.innerHTML = html;
  return document.body;
}

function stubLayout(el, { offsetWidth = 100, offsetHeight = 100, offsetParent = el.parentElement, scrollWidth, scrollHeight, clientWidth, clientHeight, rect } = {}) {
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: offsetWidth });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: offsetHeight });
  Object.defineProperty(el, "offsetParent", { configurable: true, value: offsetParent });
  if (scrollWidth !== undefined) {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  }
  if (scrollHeight !== undefined) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  }
  if (clientWidth !== undefined) {
    Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  }
  if (clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  }
  if (rect) {
    el.getBoundingClientRect = () => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    });
  }
}

function styleStub(map) {
  // Build a getComputedStyle stub backed by a Map<el, style>.
  return (el) => map.get(el) || { display: "", visibility: "", position: "", overflow: "", overflowX: "", overflowY: "" };
}

describe("findZeroSizeViolations", () => {
  it("flags a visible .wt-* element with zero width", () => {
    const root = makeTree(`<div class="wt-target"></div>`);
    const el = root.querySelector(".wt-target");
    stubLayout(el, { offsetWidth: 0, offsetHeight: 100 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static" }]]);

    const violations = findZeroSizeViolations(root, styleStub(styles), { zeroSizeThreshold: 0 });
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe("zero-size-visible");
    expect(violations[0].details).toMatchObject({ offsetWidth: 0, offsetHeight: 100 });
  });

  it("does not flag hidden elements with display:none", () => {
    const root = makeTree(`<div class="wt-hidden"></div>`);
    const el = root.querySelector(".wt-hidden");
    stubLayout(el, { offsetWidth: 0, offsetHeight: 0 });

    const styles = new Map([[el, { display: "none", visibility: "visible", position: "static" }]]);

    const violations = findZeroSizeViolations(root, styleStub(styles), { zeroSizeThreshold: 0 });
    expect(violations).toHaveLength(0);
  });

  it("does not flag visibility:hidden elements", () => {
    const root = makeTree(`<div class="wt-hidden-vis"></div>`);
    const el = root.querySelector(".wt-hidden-vis");
    stubLayout(el, { offsetWidth: 0, offsetHeight: 0 });

    const styles = new Map([[el, { display: "block", visibility: "hidden", position: "static" }]]);

    const violations = findZeroSizeViolations(root, styleStub(styles), { zeroSizeThreshold: 0 });
    expect(violations).toHaveLength(0);
  });

  it("does not flag elements without a wt- class", () => {
    const root = makeTree(`<div class="wtf-other"></div>`);
    const el = root.querySelector(".wtf-other");
    stubLayout(el, { offsetWidth: 0, offsetHeight: 0 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static" }]]);

    const violations = findZeroSizeViolations(root, styleStub(styles), { zeroSizeThreshold: 0 });
    expect(violations).toHaveLength(0);
  });

  it("returns no violations for a normally sized element", () => {
    const root = makeTree(`<div class="wt-ok"></div>`);
    const el = root.querySelector(".wt-ok");
    stubLayout(el, { offsetWidth: 200, offsetHeight: 50 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static" }]]);

    expect(findZeroSizeViolations(root, styleStub(styles), { zeroSizeThreshold: 0 })).toHaveLength(0);
  });
});

describe("findClippedOverflowViolations", () => {
  it("flags overflow:hidden with scrollHeight materially exceeding clientHeight", () => {
    const root = makeTree(`<div class="wt-box"></div>`);
    const el = root.querySelector(".wt-box");
    stubLayout(el, { offsetWidth: 100, offsetHeight: 100, scrollHeight: 500, clientHeight: 100 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static", overflow: "hidden", overflowX: "hidden", overflowY: "hidden" }]]);

    const violations = findClippedOverflowViolations(root, styleStub(styles), { clippedOverflowTolerance: 2 });
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe("clipped-overflow");
    expect(violations[0].details.axis).toBe("y");
  });

  it("respects the clipping tolerance for sub-pixel differences", () => {
    const root = makeTree(`<div class="wt-box-tight"></div>`);
    const el = root.querySelector(".wt-box-tight");
    stubLayout(el, { offsetWidth: 100, offsetHeight: 100, scrollHeight: 101, clientHeight: 100 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static", overflow: "hidden", overflowX: "hidden", overflowY: "hidden" }]]);

    expect(findClippedOverflowViolations(root, styleStub(styles), { clippedOverflowTolerance: 2 })).toHaveLength(0);
  });

  it("does not flag elements without overflow hidden", () => {
    const root = makeTree(`<div class="wt-visible"></div>`);
    const el = root.querySelector(".wt-visible");
    stubLayout(el, { offsetWidth: 100, offsetHeight: 100, scrollHeight: 500, clientHeight: 100 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static", overflow: "visible", overflowX: "visible", overflowY: "visible" }]]);

    expect(findClippedOverflowViolations(root, styleStub(styles), { clippedOverflowTolerance: 2 })).toHaveLength(0);
  });

  it("flags horizontal overflow when overflowX is hidden and scrollWidth exceeds clientWidth", () => {
    const root = makeTree(`<div class="wt-box-x"></div>`);
    const el = root.querySelector(".wt-box-x");
    stubLayout(el, { offsetWidth: 100, offsetHeight: 100, scrollWidth: 500, clientWidth: 100, scrollHeight: 100, clientHeight: 100 });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static", overflow: "hidden", overflowX: "hidden", overflowY: "visible" }]]);

    const violations = findClippedOverflowViolations(root, styleStub(styles), { clippedOverflowTolerance: 2 });
    expect(violations).toHaveLength(1);
    expect(violations[0].details.axis).toBe("x");
  });
});

describe("findOutOfBoundsViolations", () => {
  it("flags an absolutely-positioned .wt-* element entirely outside its positioned ancestor", () => {
    const root = makeTree(`
      <div class="wt-container" style="position: relative;">
        <div class="wt-child"></div>
      </div>
    `);
    const container = root.querySelector(".wt-container");
    const child = root.querySelector(".wt-child");
    stubLayout(container, { offsetWidth: 300, offsetHeight: 200, rect: { left: 0, top: 0, right: 300, bottom: 200 } });
    stubLayout(child, { offsetWidth: 50, offsetHeight: 50, offsetParent: container, rect: { left: 500, top: 0, right: 550, bottom: 50 } });

    const styles = new Map([
      [container, { display: "block", visibility: "visible", position: "relative", overflow: "visible" }],
      [child, { display: "block", visibility: "visible", position: "absolute", overflow: "visible" }],
    ]);

    const violations = findOutOfBoundsViolations(root, styleStub(styles), { outOfBoundsTolerance: 1 });
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe("out-of-bounds");
  });

  it("does not flag elements that are within their ancestor", () => {
    const root = makeTree(`
      <div class="wt-container" style="position: relative;">
        <div class="wt-child"></div>
      </div>
    `);
    const container = root.querySelector(".wt-container");
    const child = root.querySelector(".wt-child");
    stubLayout(container, { offsetWidth: 300, offsetHeight: 200, rect: { left: 0, top: 0, right: 300, bottom: 200 } });
    stubLayout(child, { offsetWidth: 50, offsetHeight: 50, offsetParent: container, rect: { left: 50, top: 50, right: 100, bottom: 100 } });

    const styles = new Map([
      [container, { display: "block", visibility: "visible", position: "relative", overflow: "visible" }],
      [child, { display: "block", visibility: "visible", position: "absolute", overflow: "visible" }],
    ]);

    expect(findOutOfBoundsViolations(root, styleStub(styles), { outOfBoundsTolerance: 1 })).toHaveLength(0);
  });

  it("does not flag statically-positioned elements even if out of parent", () => {
    const root = makeTree(`
      <div class="wt-container" style="position: relative;">
        <div class="wt-child"></div>
      </div>
    `);
    const container = root.querySelector(".wt-container");
    const child = root.querySelector(".wt-child");
    stubLayout(container, { offsetWidth: 300, offsetHeight: 200, rect: { left: 0, top: 0, right: 300, bottom: 200 } });
    stubLayout(child, { offsetWidth: 50, offsetHeight: 50, offsetParent: container, rect: { left: 500, top: 0, right: 550, bottom: 50 } });

    const styles = new Map([
      [container, { display: "block", visibility: "visible", position: "relative", overflow: "visible" }],
      [child, { display: "block", visibility: "visible", position: "static", overflow: "visible" }],
    ]);

    expect(findOutOfBoundsViolations(root, styleStub(styles), { outOfBoundsTolerance: 1 })).toHaveLength(0);
  });
});

describe("collectSanityViolations", () => {
  it("aggregates violations from all checks", () => {
    const root = makeTree(`
      <div class="wt-scroll-container">
        <div class="wt-zero"></div>
      </div>
    `);
    const scroll = root.querySelector(".wt-scroll-container");
    const zero = root.querySelector(".wt-zero");
    stubLayout(scroll, {
      offsetWidth: 100,
      offsetHeight: 100,
      scrollHeight: 500,
      clientHeight: 100,
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    stubLayout(zero, { offsetWidth: 0, offsetHeight: 0, rect: { left: 0, top: 0, right: 0, bottom: 0 } });

    const styles = new Map([
      [scroll, { display: "block", visibility: "visible", position: "static", overflow: "hidden", overflowX: "hidden", overflowY: "hidden" }],
      [zero, { display: "block", visibility: "visible", position: "static", overflow: "visible", overflowX: "visible", overflowY: "visible" }],
    ]);

    const violations = collectSanityViolations(root, { getComputedStyle: styleStub(styles) });
    const types = violations.map((v) => v.type).sort();
    expect(types).toEqual(["clipped-overflow", "zero-size-visible"]);
  });

  it("returns an empty array when no issues are present", () => {
    const root = makeTree(`<div class="wt-ok"></div>`);
    const el = root.querySelector(".wt-ok");
    stubLayout(el, { offsetWidth: 200, offsetHeight: 50, rect: { left: 0, top: 0, right: 200, bottom: 50 } });

    const styles = new Map([[el, { display: "block", visibility: "visible", position: "static", overflow: "visible" }]]);

    expect(collectSanityViolations(root, { getComputedStyle: styleStub(styles) })).toEqual([]);
  });
});

describe("buildSanityCheckCdpExpression", () => {
  it("returns a self-contained IIFE string that references the helper functions", () => {
    const expr = buildSanityCheckCdpExpression();
    expect(typeof expr).toBe("string");
    expect(expr).toContain("findZeroSizeViolations");
    expect(expr).toContain("findClippedOverflowViolations");
    expect(expr).toContain("findOutOfBoundsViolations");
    expect(expr).toMatch(/^\s*\(\(\)\s*=>\s*\{/);
  });
});
