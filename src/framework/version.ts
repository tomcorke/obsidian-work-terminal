/**
 * Build-time version information injected by esbuild via `define`.
 *
 * Three constants are substituted at build time. They are declared as
 * ambient globals here so TypeScript accepts references to them across
 * the codebase without any runtime resolution.
 *
 *   __WT_VERSION__           - The tag name if the current HEAD is tagged
 *                              (e.g. `0.5.0`), otherwise the short commit
 *                              SHA (e.g. `c072614`).
 *   __WT_IS_TAGGED__         - true iff HEAD is an exact tagged commit.
 *   __WT_VERSION_TIMESTAMP__ - ISO8601 timestamp of the tag date (when
 *                              tagged) or commit date (when not tagged).
 *
 * When esbuild runs, values are computed by `resolveBuildVersion()` in
 * esbuild.config.mjs. Outside a real build (e.g. vitest), the fallbacks
 * declared in that helper (`"dev"`, ISO `Date.now()`, `false`) keep the
 * module importable.
 */

declare const __WT_VERSION__: string;
declare const __WT_IS_TAGGED__: boolean;
declare const __WT_VERSION_TIMESTAMP__: string;

/**
 * The user-facing version string for the running plugin build.
 *
 * - On a tagged build: the tag name (e.g. "0.5.0").
 * - Otherwise: the short commit SHA (e.g. "c072614").
 */
export const WT_VERSION: string =
  typeof __WT_VERSION__ !== "undefined" ? __WT_VERSION__ : "dev";

/** True when the running build is an exact tagged commit. */
export const WT_IS_TAGGED: boolean =
  typeof __WT_IS_TAGGED__ !== "undefined" ? __WT_IS_TAGGED__ : false;

/**
 * ISO8601 timestamp associated with the running build. Tag date for
 * tagged builds, commit date otherwise. May be an empty string when the
 * build-time lookup failed (e.g. a shallow clone without tag metadata).
 */
export const WT_VERSION_TIMESTAMP: string =
  typeof __WT_VERSION_TIMESTAMP__ !== "undefined" ? __WT_VERSION_TIMESTAMP__ : "";

/**
 * Format the build timestamp for display alongside the version string.
 * Returns an empty string when the timestamp is missing or unparsable so
 * callers can safely concatenate without producing "Invalid Date" text.
 */
export function formatVersionTimestamp(iso: string = WT_VERSION_TIMESTAMP): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // Use the user's locale for the date + time. Short-form date keeps the
  // settings line compact; time is included because multiple same-day
  // dev builds are common.
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Settings-page label: version + formatted timestamp with the correct
 * "release"/"commit" qualifier based on whether the build is tagged.
 * Timestamp is omitted entirely when it can't be formatted.
 *
 * Examples:
 *   "0.5.0 (released 24 Apr 2026, 12:47)"
 *   "c072614 (committed 24 Apr 2026, 12:47)"
 *   "dev"
 */
export function formatVersionForSettings(
  version: string = WT_VERSION,
  isTagged: boolean = WT_IS_TAGGED,
  timestamp: string = WT_VERSION_TIMESTAMP,
): string {
  const formatted = formatVersionTimestamp(timestamp);
  if (!formatted) return version;
  const qualifier = isTagged ? "released" : "committed";
  return `${version} (${qualifier} ${formatted})`;
}

/**
 * Tab-title suffix: just the version/SHA, no timestamp. Produced as a
 * complete suffix including the leading separator so callers can append
 * unconditionally.
 *
 * Returns "" when `enabled` is false so `"Work Terminal" + suffix` is
 * correct with or without the toggle.
 */
export function formatVersionForTabTitle(
  enabled: boolean,
  version: string = WT_VERSION,
): string {
  if (!enabled) return "";
  if (!version) return "";
  return ` (${version})`;
}
