/**
 * Layout sanity assertions for smoke tests.
 *
 * Pure DOM-inspection helpers that run against a real browser-rendered tree
 * (e.g. the Obsidian renderer via CDP) and surface a broad class of visible
 * layout bugs without requiring per-feature baselines or maintenance. Also
 * used directly as functions in unit tests via jsdom-like mock elements.
 *
 * Exposed checks (see `collectSanityViolations`):
 *   1. `zero-size-visible`   - a `.wt-*` element is present but renders at 0
 *                              width or 0 height while being otherwise visible
 *                              (has layout, not `display:none`, not detached).
 *   2. `clipped-overflow`    - an element with `overflow:hidden` has
 *                              `scrollHeight` materially greater than
 *                              `clientHeight`, i.e. content is silently cut off.
 *   3. `out-of-bounds`       - an absolutely-positioned `.wt-*` element is
 *                              rendered entirely outside the bounding rect of
 *                              its nearest positioned ancestor.
 *
 * Designed to be serialised into a single CDP `Runtime.evaluate` call - all
 * implementation lives in top-level helpers that only reference `root`, the
 * DOM passed in, and `opts`. No closure over module scope.
 *
 * @see docs/regression-tests.md (Generic Sanity Assertions section)
 * Part of #491.
 */

/**
 * Default tolerances for the sanity checks. Intentionally forgiving - false
 * positives from sub-pixel rounding or theme-driven whitespace would erode
 * trust in the smoke runner faster than missed regressions.
 */
const DEFAULT_OPTS = Object.freeze({
  /** Size (px) below which an element is considered zero-sized. */
  zeroSizeThreshold: 0,
  /**
   * `scrollHeight` must exceed `clientHeight` by more than this many pixels
   * to count as clipped. Covers sub-pixel rounding and scrollbar gutters.
   */
  clippedOverflowTolerance: 2,
  /**
   * Positive margin (px) added to the parent's bounding rect when checking
   * out-of-bounds - an element must be fully outside *by this margin* to
   * count, so fractional positioning does not trigger a violation.
   */
  outOfBoundsTolerance: 1,
});

/**
 * Evaluate whether an element currently has CSS that would keep it out of the
 * visual flow entirely. These should not trigger zero-size warnings.
 */
function isHiddenByStyle(el, getComputedStyle) {
  const style = getComputedStyle(el);
  if (!style) return false;
  if (style.display === "none") return true;
  if (style.visibility === "hidden") return true;
  if (style.visibility === "collapse") return true;
  if (el.offsetParent === null && style.position !== "fixed") return true;
  return false;
}

/**
 * Empty layout helpers are common in the Work Terminal DOM (for example an
 * actions slot on a card with no actions, or a tab container before any tab is
 * opened). They can legitimately have zero size while still being visible.
 */
function hasRenderableContent(el, getComputedStyle) {
  if ((el.childNodes && Array.from(el.childNodes).some((node) =>
    node.nodeType === 3 && (node.textContent || "").trim().length > 0
  ))) return true;
  for (const child of Array.from(el.children || [])) {
    if (isHiddenByStyle(child, getComputedStyle)) continue;
    if (hasRenderableContent(child, getComputedStyle)) return true;
  }
  return false;
}

/**
 * Check for visible `.wt-*` elements with zero width or zero height. Only
 * flags elements that are otherwise visible - hidden tabs/panels in tabbed
 * UIs legitimately have zero layout.
 */
function findZeroSizeViolations(root, getComputedStyle, opts) {
  const violations = [];
  const nodes = root.querySelectorAll("[class*='wt-']");
  for (const el of nodes) {
    // Skip class-match false positives - the selector matches any substring.
    if (!Array.from(el.classList).some((c) => c.startsWith("wt-"))) continue;
    if (isHiddenByStyle(el, getComputedStyle)) continue;

    const w = typeof el.offsetWidth === "number" ? el.offsetWidth : 0;
    const h = typeof el.offsetHeight === "number" ? el.offsetHeight : 0;
    if (!hasRenderableContent(el, getComputedStyle)) continue;
    if (w <= opts.zeroSizeThreshold || h <= opts.zeroSizeThreshold) {
      violations.push({
        type: "zero-size-visible",
        selector: describeElement(el),
        details: { offsetWidth: w, offsetHeight: h },
      });
    }
  }
  return violations;
}

/**
 * Find elements with `overflow:hidden` whose content materially exceeds their
 * box - evidence that something is being silently clipped. We restrict to
 * `.wt-*` scoped elements to avoid flagging Obsidian core DOM.
 */
function findClippedOverflowViolations(root, getComputedStyle, opts) {
  const violations = [];
  const nodes = root.querySelectorAll("[class*='wt-']");
  for (const el of nodes) {
    if (!Array.from(el.classList).some((c) => c.startsWith("wt-"))) continue;
    if (isHiddenByStyle(el, getComputedStyle)) continue;

    const style = getComputedStyle(el);
    if (!style) continue;
    const overflowX = style.overflowX || style.overflow;
    const overflowY = style.overflowY || style.overflow;
    const isHiddenX = overflowX === "hidden" || overflowX === "clip";
    const isHiddenY = overflowY === "hidden" || overflowY === "clip";
    if (!isHiddenX && !isHiddenY) continue;

    const scrollH = typeof el.scrollHeight === "number" ? el.scrollHeight : 0;
    const clientH = typeof el.clientHeight === "number" ? el.clientHeight : 0;
    const scrollW = typeof el.scrollWidth === "number" ? el.scrollWidth : 0;
    const clientW = typeof el.clientWidth === "number" ? el.clientWidth : 0;

    if (isHiddenY && scrollH > clientH + opts.clippedOverflowTolerance && clientH > 0) {
      violations.push({
        type: "clipped-overflow",
        selector: describeElement(el),
        details: { axis: "y", scrollHeight: scrollH, clientHeight: clientH },
      });
    } else if (isHiddenX && scrollW > clientW + opts.clippedOverflowTolerance && clientW > 0) {
      violations.push({
        type: "clipped-overflow",
        selector: describeElement(el),
        details: { axis: "x", scrollWidth: scrollW, clientWidth: clientW },
      });
    }
  }
  return violations;
}

/**
 * Find absolutely-positioned `.wt-*` elements rendered entirely outside the
 * bounding rect of their nearest positioned ancestor. Equivalent to "content
 * off-screen relative to its intended stacking context".
 */
function findOutOfBoundsViolations(root, getComputedStyle, opts) {
  const violations = [];
  const nodes = root.querySelectorAll("[class*='wt-']");
  for (const el of nodes) {
    if (!Array.from(el.classList).some((c) => c.startsWith("wt-"))) continue;
    if (isHiddenByStyle(el, getComputedStyle)) continue;

    const style = getComputedStyle(el);
    if (!style) continue;
    const pos = style.position;
    if (pos !== "absolute" && pos !== "fixed") continue;

    const ancestor = findPositionedAncestor(el, getComputedStyle);
    if (!ancestor) continue;

    const elRect = el.getBoundingClientRect();
    const ancRect = ancestor.getBoundingClientRect();
    if (!elRect || !ancRect) continue;

    // An element is "fully outside" if its closest edge is beyond the
    // ancestor's far edge by more than the tolerance.
    const fullyRight = elRect.left >= ancRect.right + opts.outOfBoundsTolerance;
    const fullyLeft = elRect.right <= ancRect.left - opts.outOfBoundsTolerance;
    const fullyBelow = elRect.top >= ancRect.bottom + opts.outOfBoundsTolerance;
    const fullyAbove = elRect.bottom <= ancRect.top - opts.outOfBoundsTolerance;

    if (fullyRight || fullyLeft || fullyBelow || fullyAbove) {
      violations.push({
        type: "out-of-bounds",
        selector: describeElement(el),
        details: {
          element: { left: elRect.left, top: elRect.top, right: elRect.right, bottom: elRect.bottom },
          ancestor: { left: ancRect.left, top: ancRect.top, right: ancRect.right, bottom: ancRect.bottom },
        },
      });
    }
  }
  return violations;
}

/**
 * Walk up the parent chain, returning the nearest ancestor whose computed
 * `position` is not `static`. Returns `null` if none found before the root.
 */
function findPositionedAncestor(el, getComputedStyle) {
  let cur = el.parentElement;
  while (cur) {
    const style = getComputedStyle(cur);
    if (style && style.position && style.position !== "static") {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Produce a short, human-readable identifier for an element. Used in
 * violation output so failures point at something resembling a CSS selector.
 */
function describeElement(el) {
  const tag = (el.tagName || "div").toLowerCase();
  const cls = Array.from(el.classList || []).filter((c) => c.startsWith("wt-")).join(".");
  const id = el.id ? `#${el.id}` : "";
  return cls ? `${tag}${id}.${cls}` : `${tag}${id}`;
}

/**
 * Run all sanity assertions against the given root (defaults to the real DOM
 * when invoked in a browser context). Returns the list of violations; an
 * empty list means no issues found.
 *
 * The function is written so it can be serialised to a string and evaluated
 * via CDP - all dependencies (getComputedStyle) default to the global one
 * but can be injected for unit tests.
 */
function collectSanityViolations(root, options) {
  const opts = Object.assign({}, DEFAULT_OPTS, options || {});
  const getComputedStyle =
    (options && options.getComputedStyle) ||
    (typeof globalThis !== "undefined" && globalThis.getComputedStyle
      ? globalThis.getComputedStyle.bind(globalThis)
      : () => ({}));

  if (!root) {
    if (typeof document !== "undefined") root = document.documentElement;
    else throw new Error("collectSanityViolations: root is required");
  }

  return [
    ...findZeroSizeViolations(root, getComputedStyle, opts),
    ...findClippedOverflowViolations(root, getComputedStyle, opts),
    ...findOutOfBoundsViolations(root, getComputedStyle, opts),
  ];
}

/**
 * Build a self-contained CDP evaluation expression that will run the sanity
 * checks in the target page and return a JSON-serialisable violations array.
 *
 * The entire function body is inlined as a string so the smoke runner can
 * call CDP without requiring the target page to have any bundle loaded.
 */
function buildSanityCheckCdpExpression(options) {
  const opts = Object.assign({}, DEFAULT_OPTS, options || {});
  // Inline the function sources. `Function.prototype.toString` reliably
  // returns the source in V8, which is what the Obsidian renderer uses.
  return `
    (() => {
      const DEFAULT_OPTS = ${JSON.stringify(opts)};
      const isHiddenByStyle = ${isHiddenByStyle.toString()};
      const hasRenderableContent = ${hasRenderableContent.toString()};
      const describeElement = ${describeElement.toString()};
      const findPositionedAncestor = ${findPositionedAncestor.toString()};
      const findZeroSizeViolations = ${findZeroSizeViolations.toString()};
      const findClippedOverflowViolations = ${findClippedOverflowViolations.toString()};
      const findOutOfBoundsViolations = ${findOutOfBoundsViolations.toString()};
      const getComputedStyle = window.getComputedStyle.bind(window);
      const root = document.documentElement;
      const opts = DEFAULT_OPTS;
      return [
        ...findZeroSizeViolations(root, getComputedStyle, opts),
        ...findClippedOverflowViolations(root, getComputedStyle, opts),
        ...findOutOfBoundsViolations(root, getComputedStyle, opts),
      ];
    })()
  `;
}

module.exports = {
  collectSanityViolations,
  buildSanityCheckCdpExpression,
  // Exported for unit tests.
  findZeroSizeViolations,
  findClippedOverflowViolations,
  findOutOfBoundsViolations,
  findPositionedAncestor,
  isHiddenByStyle,
  describeElement,
  DEFAULT_OPTS,
};
