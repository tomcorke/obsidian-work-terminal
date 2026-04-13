/**
 * Re-exports core card flag rule parsing/serialization for backward compatibility.
 * The actual implementation lives in core/cardFlags.ts.
 */
export {
  parseCardFlagRulesJson as parseCustomCardFlags,
  serializeCardFlagRules as serializeCustomCardFlags,
} from "../../core/cardFlags";
