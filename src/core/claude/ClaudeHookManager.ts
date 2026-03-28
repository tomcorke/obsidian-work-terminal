/**
 * Claude hook management for session resume tracking.
 * Installs/removes hook scripts and settings.local.json entries,
 * reads resume events written by the hook script.
 */
import { expandTilde, electronRequire } from "../utils";

const fs = electronRequire("fs") as typeof import("fs");
const path = electronRequire("path") as typeof import("path");
const childProcess = electronRequire("child_process") as typeof import("child_process");

const HOOK_DIR = expandTilde("~/.work-terminal/hooks");
const EVENTS_DIR = expandTilde("~/.work-terminal/events");
const SCRIPT_PATH = path.join(HOOK_DIR, "session-change.sh");

/** Stale event cleanup threshold (5 minutes). */
const STALE_MS = 5 * 60 * 1000;

/** Max time gap between end and start events to consider them a resume pair (5 seconds). */
const RESUME_WINDOW_MS = 5 * 1000;

/**
 * Hook script template. Uses python3 for reliable JSON parsing on macOS.
 * Claude pipes hook input as JSON on stdin. The script filters for
 * SessionEnd (reason=resume) and SessionStart (source=resume) events,
 * writing structured event files that the plugin reads to detect resumes.
 */
const HOOK_SCRIPT = `#!/bin/bash
# work-terminal session-change hook
# Reads Claude hook JSON from stdin and writes resume event files.

EVENTS_DIR="$HOME/.work-terminal/events"
mkdir -p "$EVENTS_DIR"

INPUT=$(cat)

python3 -c "
import json, sys, time, os

events_dir = os.path.expanduser('~/.work-terminal/events')
data = json.loads(sys.stdin.read())

hook_name = data.get('hook_event_name', '')
session_id = data.get('session_id', '')
ts = int(time.time() * 1000)

if hook_name == 'SessionEnd':
    # SessionEnd does not support matchers, so check reason in script
    reason = data.get('reason', '')
    if reason == 'resume' and session_id:
        out = json.dumps({'event': 'end', 'session_id': session_id, 'timestamp': ts})
        path = os.path.join(events_dir, f'{session_id}-end.json')
        with open(path, 'w') as f:
            f.write(out)

elif hook_name == 'SessionStart':
    source = data.get('source', '')
    if source == 'resume' and session_id:
        out = json.dumps({'event': 'start', 'session_id': session_id, 'timestamp': ts})
        path = os.path.join(events_dir, f'{session_id}-start.json')
        with open(path, 'w') as f:
            f.write(out)
" <<< "$INPUT"
`;

/**
 * The hook entries to merge into .claude/settings.local.json.
 * SessionEnd has no matcher (not supported); SessionStart uses "resume" matcher.
 */
function hookSettingsEntries(): Record<string, unknown> {
  return {
    hooks: {
      SessionEnd: [
        {
          hooks: [{ type: "command", command: SCRIPT_PATH }],
        },
      ],
      SessionStart: [
        {
          matcher: "resume",
          hooks: [{ type: "command", command: SCRIPT_PATH }],
        },
      ],
    },
  };
}

/**
 * Check whether the hook script exists and whether the CWD's
 * .claude/settings.local.json contains the hook entries.
 */
export function checkHookStatus(cwd: string): { scriptExists: boolean; hooksConfigured: boolean } {
  const scriptExists = fs.existsSync(SCRIPT_PATH);

  let hooksConfigured = false;
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const hooks = settings?.hooks;
      hooksConfigured = !!(
        hooks?.SessionEnd?.length &&
        hooks?.SessionStart?.length &&
        JSON.stringify(hooks.SessionEnd).includes(SCRIPT_PATH) &&
        JSON.stringify(hooks.SessionStart).includes(SCRIPT_PATH)
      );
    } catch {
      /* corrupt settings file */
    }
  }

  return { scriptExists, hooksConfigured };
}

/**
 * Install the hook script and merge hook entries into .claude/settings.local.json.
 * Preserves any existing settings in the file.
 */
export async function installHooks(cwd: string): Promise<void> {
  // Create directories
  fs.mkdirSync(HOOK_DIR, { recursive: true });
  fs.mkdirSync(EVENTS_DIR, { recursive: true });

  // Write and chmod the hook script
  fs.writeFileSync(SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });
  childProcess.execSync(`chmod +x "${SCRIPT_PATH}"`);

  // Merge into .claude/settings.local.json
  const claudeDir = path.join(cwd, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, "settings.local.json");
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      /* start fresh if corrupt */
    }
  }

  const hookEntries = hookSettingsEntries();
  const existingHooks: Record<string, unknown> = (existing.hooks as Record<string, unknown>) || {};
  const merged = {
    ...existing,
    hooks: { ...existingHooks, ...(hookEntries.hooks as Record<string, unknown>) },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Remove hook entries from .claude/settings.local.json and delete the hook script.
 */
export async function removeHooks(cwd: string): Promise<void> {
  // Remove hook entries from settings
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.hooks) {
        delete settings.hooks.SessionEnd;
        delete settings.hooks.SessionStart;
        // Clean up empty hooks object
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
      }
      // Write back even if empty (preserve other settings)
      if (Object.keys(settings).length > 0) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      } else {
        fs.unlinkSync(settingsPath);
      }
    } catch {
      /* ignore corrupt file */
    }
  }

  // Delete script file
  if (fs.existsSync(SCRIPT_PATH)) {
    fs.unlinkSync(SCRIPT_PATH);
  }
}

/**
 * Check for a resume event chain: oldSessionId ended, and a new session started
 * within 5 seconds. Returns the new session ID or null.
 */
export function readResumeEvent(oldSessionId: string): { newSessionId: string } | null {
  const endFile = path.join(EVENTS_DIR, `${oldSessionId}-end.json`);
  if (!fs.existsSync(endFile)) return null;

  let endData: { event: string; session_id: string; timestamp: number };
  try {
    endData = JSON.parse(fs.readFileSync(endFile, "utf-8"));
  } catch {
    return null;
  }

  // Scan for start events within the resume window
  let startFiles: string[];
  try {
    startFiles = fs.readdirSync(EVENTS_DIR).filter((f: string) => f.endsWith("-start.json"));
  } catch {
    return null;
  }

  let closest: { sessionId: string; gap: number } | null = null;

  for (const file of startFiles) {
    try {
      const startData = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, file), "utf-8"));
      const gap = startData.timestamp - endData.timestamp;
      if (gap >= 0 && gap <= RESUME_WINDOW_MS) {
        if (!closest || gap < closest.gap) {
          closest = { sessionId: startData.session_id, gap };
        }
      }
    } catch {
      /* skip corrupt files */
    }
  }

  return closest ? { newSessionId: closest.sessionId } : null;
}

/**
 * Remove event files older than 5 minutes.
 */
export function cleanupStaleEvents(): void {
  if (!fs.existsSync(EVENTS_DIR)) return;

  const now = Date.now();
  let files: string[];
  try {
    files = fs.readdirSync(EVENTS_DIR);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(EVENTS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > STALE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      /* ignore */
    }
  }
}
