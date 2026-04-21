/**
 * Detail view placement options.
 *
 * Controls how the detail view for a selected work item is opened relative to
 * the Work Terminal view. Users with single-pane or tab-based layouts can
 * pick an option that respects their workspace arrangement.
 *
 * - `split` - default. Create a new split beside the Work Terminal view and
 *   optionally apply a min-width override so the editor does not squish.
 * - `tab` - open the detail file as a new tab in the currently active tab
 *   group (no splitting, no width override).
 * - `navigate` - replace the contents of the currently active leaf, matching
 *   the standard Obsidian "file open" behaviour.
 * - `preview` - render the task file's markdown read-only inside the Work
 *   Terminal panel itself, as an overlay above the terminal area. Provides
 *   an "Open in editor" button that falls back to the `navigate` behaviour.
 * - `disabled` - do nothing on selection. Users open files manually via the
 *   file explorer, quick switcher, or context menu.
 */
export type DetailViewPlacement = "split" | "tab" | "navigate" | "preview" | "disabled";

/** Orientation for the `split` placement. Matches Obsidian's createLeafBySplit arg. */
export type DetailViewSplitDirection = "vertical" | "horizontal";

/** Resolved, strongly-typed options for TaskDetailView behaviour. */
export interface DetailViewOptions {
  placement: DetailViewPlacement;
  /** Apply min-width flex override. Only meaningful when placement is "split". */
  widthOverride: boolean;
  /** Detach the detail leaf when a different item is selected. */
  autoClose: boolean;
  /** Orientation for createLeafBySplit. Only meaningful when placement is "split". */
  splitDirection: DetailViewSplitDirection;
}

export const DETAIL_VIEW_DEFAULTS: DetailViewOptions = {
  placement: "split",
  widthOverride: true,
  autoClose: false,
  splitDirection: "vertical",
};

const VALID_PLACEMENTS: ReadonlySet<string> = new Set([
  "split",
  "tab",
  "navigate",
  "preview",
  "disabled",
]);

const VALID_SPLIT_DIRECTIONS: ReadonlySet<string> = new Set(["vertical", "horizontal"]);

/**
 * Resolve typed DetailViewOptions from a flat settings map. Unknown or invalid
 * values fall back to the defaults, which preserves backwards-compatible
 * behaviour (split, width override on, horizontal split off, auto-close off).
 */
export function resolveDetailViewOptions(
  settings: Record<string, unknown> | undefined,
): DetailViewOptions {
  const s = settings ?? {};

  const rawPlacement = s["core.detailViewPlacement"];
  const placement: DetailViewPlacement =
    typeof rawPlacement === "string" && VALID_PLACEMENTS.has(rawPlacement)
      ? (rawPlacement as DetailViewPlacement)
      : DETAIL_VIEW_DEFAULTS.placement;

  const rawDirection = s["core.detailViewSplitDirection"];
  const splitDirection: DetailViewSplitDirection =
    typeof rawDirection === "string" && VALID_SPLIT_DIRECTIONS.has(rawDirection)
      ? (rawDirection as DetailViewSplitDirection)
      : DETAIL_VIEW_DEFAULTS.splitDirection;

  const rawWidthOverride = s["core.detailViewWidthOverride"];
  const widthOverride =
    typeof rawWidthOverride === "boolean" ? rawWidthOverride : DETAIL_VIEW_DEFAULTS.widthOverride;

  const rawAutoClose = s["core.detailViewAutoClose"];
  const autoClose =
    typeof rawAutoClose === "boolean" ? rawAutoClose : DETAIL_VIEW_DEFAULTS.autoClose;

  return { placement, widthOverride, autoClose, splitDirection };
}
