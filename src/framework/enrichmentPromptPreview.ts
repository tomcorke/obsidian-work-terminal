/**
 * Pure helpers for enrichment prompt display. Kept separate from the modal so
 * they can be unit-tested without jsdom, and so BackgroundEnrich remains the
 * single source of truth for the default prompt templates while this file
 * only concerns itself with how the preview is formatted.
 */

/** The example placeholder substitutions used when users request a preview. */
export const DEFAULT_PREVIEW_VARS: Record<string, string> = {
  filePath: "vault/2 - Areas/Tasks/todo/example.md",
};

/**
 * Substitute `$name` placeholders in a prompt template with the provided
 * variable map. Unknown placeholders are left untouched so users can see
 * exactly which ones the resolver recognises. Matches camelCase identifiers
 * starting with a letter - so `$filePath` resolves but adjacent text like
 * `$1filePath` does not accidentally absorb digits as a placeholder.
 */
export function resolvePromptPreview(
  template: string,
  vars: Record<string, string> = DEFAULT_PREVIEW_VARS,
): string {
  if (!template) return "";
  return template.replace(/\$([a-zA-Z][a-zA-Z0-9]*)/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return vars[name];
    }
    return match;
  });
}

/**
 * Produce a short placeholder hint summarising the default prompt for an
 * empty textarea. Shows a short leading fragment plus an instruction that
 * leaving the field blank uses the default.
 */
export function describePromptPlaceholder(defaultPrompt: string, maxChars = 120): string {
  const trimmed = defaultPrompt.trim();
  if (!trimmed) return "(default - leave blank to use)";
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/, 1)[0] || trimmed;
  // When truncating we keep the final snippet (including the ellipsis) within
  // maxChars so callers can reason about the bound independently of the
  // suffix we append.
  const snippet =
    firstSentence.length > maxChars
      ? `${firstSentence.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
      : firstSentence;
  return `${snippet} (default - leave blank to use)`;
}
