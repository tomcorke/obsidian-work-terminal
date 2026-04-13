/**
 * Card flag rule matching - resolves flag rules against work item metadata
 * and produces matched flag descriptors for rendering.
 */
import type { CardFlagRule, CardFlagStyle } from "./interfaces";

/** A matched flag ready for rendering on a card. */
export interface MatchedCardFlag {
  label: string;
  style: CardFlagStyle;
  color?: string;
  tooltip?: string;
}

/**
 * Resolve a dot-separated path against a nested object.
 * E.g. resolveDotPath({ a: { b: 1 } }, "a.b") => 1
 */
export function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Resolve a tooltip template by replacing `{{dot.path}}` placeholders
 * with values from metadata.
 */
export function resolveTooltipTemplate(
  template: string,
  metadata: Record<string, unknown>,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const val = resolveDotPath(metadata, path.trim());
    return val != null ? String(val) : "";
  });
}

/**
 * Evaluate all flag rules against a work item's metadata and return
 * the list of matched flags in rule order.
 */
export function matchCardFlags(
  rules: CardFlagRule[],
  metadata: Record<string, unknown>,
): MatchedCardFlag[] {
  const matched: MatchedCardFlag[] = [];

  for (const rule of rules) {
    if (rule.value !== undefined && rule.contains !== undefined) {
      console.warn(
        `[work-terminal] Card flag rule "${rule.label}" has both "value" and "contains" set. ` +
          `Only "contains" will be used. Remove one to silence this warning.`,
      );
    }

    const fieldValue = resolveDotPath(metadata, rule.field);

    let isMatch = false;

    if (rule.contains !== undefined) {
      // "contains" matching: works on arrays and strings
      if (Array.isArray(fieldValue)) {
        isMatch = fieldValue.includes(rule.contains);
      } else if (typeof fieldValue === "string") {
        isMatch = fieldValue.includes(rule.contains);
      }
    } else if (rule.value !== undefined) {
      // Exact value match
      isMatch = fieldValue === rule.value;
    } else {
      // No value/contains specified: match on truthy
      isMatch = !!fieldValue;
    }

    if (isMatch) {
      matched.push({
        label: rule.label,
        style: rule.style || "badge",
        color: rule.color,
        tooltip: rule.tooltip ? resolveTooltipTemplate(rule.tooltip, metadata) : undefined,
      });
    }
  }

  return matched;
}
