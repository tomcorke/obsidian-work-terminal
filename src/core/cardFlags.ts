/**
 * Card flag rule matching - resolves flag rules against work item metadata
 * and produces matched flag descriptors for rendering.
 */
import type { CardFlagRule, CardFlagOperator, CardFlagStyle } from "./interfaces";

/** Track rules that have already emitted a config warning to avoid spamming on every render. */
const warnedRules = new Set<string>();

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
 * Evaluate an operator-based match against a resolved field value.
 * Returns true if the field value satisfies the operator + operand condition.
 */
export function evaluateOperator(
  fieldValue: unknown,
  operator: CardFlagOperator,
  operand: string,
): boolean {
  switch (operator) {
    case "eq":
      // Coerce to string for comparison (settings always store operand as string)
      return String(fieldValue) === operand;

    case "neq":
      return String(fieldValue) !== operand;

    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const numField = Number(fieldValue);
      const numOperand = Number(operand);
      if (isNaN(numField) || isNaN(numOperand)) return false;
      if (operator === "gt") return numField > numOperand;
      if (operator === "lt") return numField < numOperand;
      if (operator === "gte") return numField >= numOperand;
      return numField <= numOperand;
    }

    case "contains":
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(operand);
      }
      if (typeof fieldValue === "string") {
        return fieldValue.includes(operand);
      }
      return false;

    case "regex":
      try {
        const re = new RegExp(operand);
        return re.test(String(fieldValue ?? ""));
      } catch {
        return false;
      }

    default:
      return false;
  }
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
    // Legacy warning for ambiguous value + contains
    if (rule.value !== undefined && rule.contains !== undefined && !rule.operator) {
      const ruleKey = rule.label ?? rule.field;
      if (!warnedRules.has(ruleKey)) {
        warnedRules.add(ruleKey);
        console.warn(
          `[work-terminal] Card flag rule "${rule.label}" has both "value" and "contains" set. ` +
            `Only "contains" will be used. Remove one to silence this warning.`,
        );
      }
    }

    const fieldValue = resolveDotPath(metadata, rule.field);

    let isMatch = false;

    if (rule.operator && rule.operand !== undefined) {
      // New operator-based matching (takes priority over legacy fields)
      isMatch = evaluateOperator(fieldValue, rule.operator, rule.operand);
    } else if (rule.contains !== undefined) {
      // Legacy "contains" matching: works on arrays and strings
      if (Array.isArray(fieldValue)) {
        isMatch = fieldValue.includes(rule.contains);
      } else if (typeof fieldValue === "string") {
        isMatch = fieldValue.includes(rule.contains);
      }
    } else if (rule.value !== undefined) {
      // Legacy exact value match
      isMatch = fieldValue === rule.value;
    } else {
      // No match fields specified: match on truthy
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
