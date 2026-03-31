/**
 * One-time Python 3 availability check for terminal spawn.
 *
 * Caches the result per session so we only check once - the binary
 * is unlikely to appear or disappear mid-session.
 */
import { resolveCommandInfo, type ResolveCommandInfoDeps } from "../agents/AgentLauncher";

export const PYTHON3_MISSING_MESSAGE =
  "Python 3 is required for terminal tabs. Install Python 3.7+ and ensure `python3` is on your PATH.";

let cachedResult: boolean | null = null;

/**
 * Check whether `python3` is available on PATH.
 * Returns true if found, false otherwise. Result is cached for the session.
 */
export function checkPython3Available(deps?: ResolveCommandInfoDeps): boolean {
  if (cachedResult !== null) {
    return cachedResult;
  }
  const result = resolveCommandInfo("python3", undefined, deps);
  cachedResult = result.found;
  if (!result.found) {
    console.warn("[work-terminal] python3 not found on PATH");
  }
  return cachedResult;
}

/**
 * Reset the cached result. Useful for testing or if the user installs Python
 * mid-session and wants to retry.
 */
export function resetPython3Cache(): void {
  cachedResult = null;
}
