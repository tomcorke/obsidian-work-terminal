/**
 * Card flag rule matching, parsing, and serialization.
 *
 * Resolves flag rules against work item metadata and produces matched
 * flag descriptors for rendering. Also provides parse/serialize helpers
 * for storing user-defined rules as JSON in settings.
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

/* =============================================================================
   JSON parsing / serialization for user-defined card flag rules
   ============================================================================= */

/** Valid operator values for validation. */
const VALID_OPERATORS: CardFlagOperator[] = [
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
  "regex",
];

/** Valid style values for validation. */
const VALID_STYLES: CardFlagStyle[] = ["badge", "accent-border", "background-tint"];

/**
 * Parse a JSON string of card flag rules into validated CardFlagRule[].
 * Returns an empty array on parse failure or invalid structure. Individual
 * rules with missing required fields are skipped with a console warning.
 */
export function parseCardFlagRulesJson(json: string): CardFlagRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    if (json && json !== "[]") {
      console.warn("[work-terminal] Failed to parse card flag rules JSON:", json);
    }
    return [];
  }

  if (!Array.isArray(raw)) {
    console.warn("[work-terminal] Card flag rules must be an array, got:", typeof raw);
    return [];
  }

  const rules: CardFlagRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") continue;

    const obj = entry as Record<string, unknown>;
    const field = typeof obj.field === "string" ? obj.field.trim() : "";
    const label = typeof obj.label === "string" ? obj.label.trim() : "";

    if (!field || !label) {
      console.warn(`[work-terminal] Skipping card flag rule at index ${i}: missing field or label`);
      continue;
    }

    const rule: CardFlagRule = { field, label };

    // Operator + operand
    if (
      typeof obj.operator === "string" &&
      VALID_OPERATORS.includes(obj.operator as CardFlagOperator)
    ) {
      rule.operator = obj.operator as CardFlagOperator;
      rule.operand = typeof obj.operand === "string" ? obj.operand : String(obj.operand ?? "");
    }

    // Legacy value/contains (ignored if operator is set)
    if (obj.value !== undefined && !rule.operator) {
      rule.value = obj.value;
    }
    if (typeof obj.contains === "string" && !rule.operator) {
      rule.contains = obj.contains;
    }

    // Style
    if (typeof obj.style === "string" && VALID_STYLES.includes(obj.style as CardFlagStyle)) {
      rule.style = obj.style as CardFlagStyle;
    }

    // Color
    if (typeof obj.color === "string" && obj.color.trim()) {
      rule.color = obj.color.trim();
    }

    // Tooltip
    if (typeof obj.tooltip === "string" && obj.tooltip.trim()) {
      rule.tooltip = obj.tooltip.trim();
    }

    rules.push(rule);
  }

  return rules;
}

/**
 * Serialize card flag rules to a JSON string for storage in settings.
 * Only includes fields that are set (omits undefined optional fields).
 */
export function serializeCardFlagRules(rules: CardFlagRule[]): string {
  const clean = rules.map((rule) => {
    const obj: Record<string, unknown> = {
      field: rule.field,
      label: rule.label,
    };
    if (rule.operator) obj.operator = rule.operator;
    if (rule.operand !== undefined) obj.operand = rule.operand;
    if (rule.value !== undefined && !rule.operator) obj.value = rule.value;
    if (rule.contains !== undefined && !rule.operator) obj.contains = rule.contains;
    if (rule.style) obj.style = rule.style;
    if (rule.color) obj.color = rule.color;
    if (rule.tooltip) obj.tooltip = rule.tooltip;
    return obj;
  });
  return JSON.stringify(clean);
}
