/**
 * Parsing and serialization helpers for user-defined custom card flag rules.
 * Rules are stored as a JSON string in adapter settings ("adapter.customCardFlags").
 */
import type { CardFlagRule, CardFlagOperator, CardFlagStyle } from "../../core/interfaces";

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
 * Parse a JSON string of custom card flag rules into validated CardFlagRule[].
 * Returns an empty array on parse failure or invalid structure. Individual
 * rules with missing required fields are skipped with a console warning.
 */
export function parseCustomCardFlags(json: string): CardFlagRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    if (json && json !== "[]") {
      console.warn("[work-terminal] Failed to parse custom card flags JSON:", json);
    }
    return [];
  }

  if (!Array.isArray(raw)) {
    console.warn("[work-terminal] Custom card flags must be an array, got:", typeof raw);
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
      console.warn(
        `[work-terminal] Skipping custom card flag rule at index ${i}: missing field or label`,
      );
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

    // Legacy value/contains (ignored if operator is set, but still preserved for round-tripping)
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
export function serializeCustomCardFlags(rules: CardFlagRule[]): string {
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
