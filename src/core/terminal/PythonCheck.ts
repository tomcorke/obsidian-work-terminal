/**
 * One-time Python 3 availability check for terminal spawn.
 *
 * Caches the result per session so we only check once - the binary
 * is unlikely to appear or disappear mid-session.
 */
import { resolveCommandInfo, type ResolveCommandInfoDeps } from "../agents/AgentLauncher";

export const PYTHON3_MISSING_MESSAGE =
  "Python 3 is required for terminal tabs. Install Python 3.7+ and ensure `python3` is on your PATH.";

let cachedResult: { resolvedPath: string } | false | null = null;
let notified = false;

/**
 * Check whether `python3` is available on the augmented PATH
 * (includes common tool directories like /opt/homebrew/bin).
 *
 * Returns the resolved absolute path when found, or null if missing.
 * The result is cached for the session lifetime.
 */
export function checkPython3Available(deps?: ResolveCommandInfoDeps): string | null {
  if (cachedResult !== null) {
    return cachedResult === false ? null : cachedResult.resolvedPath;
  }
  const result = resolveCommandInfo("python3", undefined, deps);
  if (result.found) {
    cachedResult = { resolvedPath: result.resolved };
    return result.resolved;
  }
  cachedResult = false;
  console.warn("[work-terminal] python3 not found on augmented PATH");
  return null;
}

/**
 * Returns true if a missing-python Notice has already been shown this session.
 * Call `markPython3Notified()` after showing the Notice.
 */
export function hasPython3BeenNotified(): boolean {
  return notified;
}

export function markPython3Notified(): void {
  notified = true;
}

/**
 * Reset the cached result and notification flag. Useful for testing or if the
 * user installs Python mid-session and wants to retry.
 */
export function resetPython3Cache(): void {
  cachedResult = null;
  notified = false;
}
