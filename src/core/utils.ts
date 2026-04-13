/**
 * Expand leading tilde to home directory.
 */
export function expandTilde(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

/**
 * Strip ANSI escape sequences from a string.
 * Two-stage approach:
 * 1. Replace CSI cursor-forward (ESC[nC) with n spaces (preserves text alignment)
 * 2. Strip all remaining ANSI/control sequences except tab/newline/CR
 */
export function stripAnsi(s: string): string {
  // Stage 1: Replace cursor-forward ESC[nC with n spaces
  let result = s.replace(/\x1b\[(\d+)C/g, (_match, n) => " ".repeat(parseInt(n, 10)));
  // Stage 2: Strip remaining ANSI sequences (CSI, OSC, other ESC sequences)
  result = result.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // CSI sequences
  result = result.replace(/\x1b\][^\x07]*\x07/g, ""); // OSC sequences (ESC]...BEL)
  result = result.replace(/\x1b\][^\x1b]*\x1b\\/g, ""); // OSC sequences (ESC]...ST)
  result = result.replace(/\x1b[^[\]]/g, ""); // Other ESC sequences
  // Strip control characters except tab (0x09), newline (0x0a), carriage return (0x0d)
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return result;
}

/**
 * Require a module in Electron context (uses window.require) with fallback to Node require.
 */
export function electronRequire(moduleName: string): any {
  if (typeof window !== "undefined" && window.require) {
    return window.require(moduleName);
  }
  return require(moduleName);
}

declare global {
  interface Window {
    require?: NodeRequire;
  }
}

/**
 * Title-case a kebab-case or snake_case identifier.
 * Splits on `-` and `_`, capitalizes each word, joins with spaces.
 * e.g. "blocked-upstream" -> "Blocked Upstream", "my_custom_state" -> "My Custom State"
 */
export function titleCase(text: string): string {
  if (!text) return "";
  return text
    .split(/[-_]/)
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

/**
 * Quote a value for safe embedding in YAML frontmatter.
 * Wraps in double quotes when the value contains characters that would
 * break YAML parsing: `#`, `: `, leading/trailing whitespace, or
 * values that match YAML boolean literals (yes/no/on/off/true/false).
 * Always escapes embedded backslashes, double quotes, and newlines.
 */
export function yamlQuoteValue(value: string): string {
  const needsQuoting =
    /[#:{}[\]|>&*!,'"%@`\n\r\\]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(value) ||
    value.length === 0;

  if (!needsQuoting) return value;

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Convert text to a URL/filename-safe kebab-case slug.
 * Max 40 characters, no leading/trailing hyphens.
 */
export function slugify(text: string): string {
  if (!text) return "";
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 40) {
    slug = slug.slice(0, 40).replace(/-+$/, "");
  }
  return slug;
}

/**
 * Check whether a string is a valid CSS color value.
 * Returns false for empty, whitespace-only, or invalid values.
 */
export function isValidCssColor(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && CSS.supports("color", trimmed);
}

/**
 * Convert Obsidian internal links to plain display text for UI rendering.
 * [[Doc]] -> Doc
 * [[Doc|Alias]] -> Alias
 */
export function normalizeObsidianDisplayText(text: string): string {
  return text.replace(/\[\[([^[\]]+)\]\]/g, (_match, linkBody: string) => {
    const [target, alias] = linkBody.split("|", 2);
    return alias?.trim() || target.trim();
  });
}
