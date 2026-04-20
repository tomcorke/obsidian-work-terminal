/**
 * splitTaskProfile - profile and cwd resolution helpers for action-driven
 * Claude launches (Split Task, Retry Enrichment).
 *
 * Issue #448 routes these actions through the agent-profile pipeline so they
 * inherit the user's configured command, args, and cwd. Resolution chains
 * are intentionally small and data-only so they can be unit-tested without
 * spinning up TerminalPanelView.
 *
 * ## Fallback chains
 *
 * Split Task profile:
 *   adapter.splitTaskProfile
 *     -> default-claude-ctx
 *     -> default-claude
 *     -> first Claude profile
 *     -> null
 *
 * Retry Enrichment profile:
 *   adapter.retryEnrichmentProfile
 *     -> adapter.enrichmentProfile (shared with background enrichment)
 *     -> default-claude-ctx
 *     -> default-claude
 *     -> first Claude profile
 *     -> null
 *
 * Cwd (for both actions):
 *   1. Profile's own defaultCwd (if non-empty)
 *   2. Parent directory of the resolved task file (absolute path)
 *   3. core.defaultTerminalCwd
 *   4. "~"
 */
import type { AgentProfile } from "../core/agents/AgentProfile";

const DEFAULT_CLAUDE_CTX_ID = "default-claude-ctx";
const DEFAULT_CLAUDE_ID = "default-claude";

/**
 * Resolve the profile to use for the Split Task action from user settings.
 * Prefers the user's configured profile; otherwise falls back to the built-in
 * "Claude (ctx)" profile so users get contextual Claude behaviour by default.
 * Returns null only when no Claude profile exists at all (edge case -
 * the caller should fall through to the legacy non-profile spawn path).
 */
export function resolveSplitTaskProfile(
  settings: Record<string, unknown>,
  availableProfiles: AgentProfile[],
): AgentProfile | null {
  const configuredId = settings["adapter.splitTaskProfile"];
  return resolveProfileWithFallbacks(
    typeof configuredId === "string" ? configuredId : undefined,
    availableProfiles,
    [DEFAULT_CLAUDE_CTX_ID, DEFAULT_CLAUDE_ID],
  );
}

/**
 * Resolve the profile to use for Retry Enrichment.
 * Falls back to the shared `adapter.enrichmentProfile` setting when the
 * action-specific binding is empty so the retry path stays consistent with
 * background enrichment, then to the built-in Claude (ctx) profile.
 */
export function resolveRetryEnrichmentProfile(
  settings: Record<string, unknown>,
  availableProfiles: AgentProfile[],
): AgentProfile | null {
  const configuredId = settings["adapter.retryEnrichmentProfile"];
  const enrichmentFallbackId = settings["adapter.enrichmentProfile"];
  const candidates: string[] = [];
  if (typeof enrichmentFallbackId === "string" && enrichmentFallbackId.trim()) {
    candidates.push(enrichmentFallbackId.trim());
  }
  candidates.push(DEFAULT_CLAUDE_CTX_ID, DEFAULT_CLAUDE_ID);
  return resolveProfileWithFallbacks(
    typeof configuredId === "string" ? configuredId : undefined,
    availableProfiles,
    candidates,
  );
}

/** Tracks whether we have already warned about a non-Claude configured profile.
 *  Avoids spamming the console on every context-menu open. */
let warnedNonClaudeConfig = false;

function isClaudeProfile(profile: AgentProfile): boolean {
  // Split Task / Retry Enrichment launch through spawnClaudeWithPrompt, which
  // assumes the Claude agent type. Keep this check aligned with the AgentType
  // enum in AgentProfile.ts - only claude-family profiles are accepted.
  return profile.agentType === "claude";
}

function resolveProfileWithFallbacks(
  configuredId: string | undefined,
  availableProfiles: AgentProfile[],
  fallbackIds: string[],
): AgentProfile | null {
  const byId = new Map(availableProfiles.map((p) => [p.id, p]));

  if (configuredId && configuredId.trim()) {
    const match = byId.get(configuredId.trim());
    if (match && isClaudeProfile(match)) return match;
    if (match && !isClaudeProfile(match)) {
      // Configured profile exists but is not claude-family - fall through to
      // defaults rather than launching a shell/copilot/custom profile that
      // spawnClaudeWithPrompt cannot handle. Warn once so the user can notice
      // the stale binding.
      if (!warnedNonClaudeConfig) {
        console.warn(
          `[work-terminal] Configured profile "${match.id}" (agentType="${match.agentType}") is not a Claude profile; ignoring and falling back.`,
        );
        warnedNonClaudeConfig = true;
      }
    }
    // Configured id no longer exists or was rejected - fall through to
    // defaults rather than throwing, so a renamed/deleted profile does not
    // silently break the feature for the user.
  }

  for (const id of fallbackIds) {
    const match = byId.get(id);
    if (match && isClaudeProfile(match)) return match;
  }

  // Last resort: any Claude profile at all.
  const anyClaude = availableProfiles.find(isClaudeProfile);
  return anyClaude ?? null;
}

/**
 * Resolve the cwd for a Split Task / Retry Enrichment launch.
 *
 * Order:
 *   1. Profile's own `defaultCwd` (if non-empty) - lets power users pin a
 *      specific cwd per profile (e.g. a repo root).
 *   2. Parent directory of the task file when provided. Launching in the
 *      task's folder makes file references in the prompt relative to the
 *      task itself.
 *   3. `core.defaultTerminalCwd` - matches legacy behaviour.
 *   4. Literal "~" as an absolute-last fallback.
 *
 * `taskAbsPath` should be absolute; we only use its parent directory and
 * do NOT call expandTilde - that is the spawn layer's job.
 */
export function resolveSplitTaskCwd(
  profile: AgentProfile | null,
  taskAbsPath: string | null,
  settings: Record<string, unknown>,
): string {
  if (profile?.defaultCwd && profile.defaultCwd.trim()) {
    return profile.defaultCwd.trim();
  }
  if (taskAbsPath) {
    const parent = parentDirectory(taskAbsPath);
    if (parent) return parent;
  }
  const coreCwd = settings["core.defaultTerminalCwd"];
  if (typeof coreCwd === "string" && coreCwd.trim()) return coreCwd;
  return "~";
}

/**
 * Return the parent directory portion of an absolute path, or null if the
 * path has no usable separator. Handles both POSIX (`/`) and Windows/UNC
 * (`\`) separators so it behaves correctly regardless of how the vault
 * adapter reports its base path. Uses a simple string split so this stays
 * dependency-free and trivially unit-testable.
 */
function parentDirectory(absPath: string): string | null {
  const trimmed = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}
