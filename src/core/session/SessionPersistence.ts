/**
 * Disk persistence for Claude session metadata.
 *
 * Saves/loads session metadata via Obsidian's plugin data API so Claude
 * sessions can be resumed after a full plugin close/restart (not just
 * hot-reload). Uses a merge pattern to avoid clobbering other plugin data
 * (settings, taskOrder, etc.) stored in the same data.json file.
 *
 * Sessions older than 7 days are pruned on load (Claude's default retention).
 */
import type { PersistedSession, SessionType } from "./types";

/** Plugin-like interface for data persistence (avoids importing Obsidian types). */
interface DataPlugin {
  loadData(): Promise<any>;
  saveData(data: any): Promise<void>;
}

/** Tab-like interface for extracting persistable data. */
interface PersistableTab {
  label: string;
  taskPath: string | null;
  claudeSessionId: string | null;
  isClaudeSession: boolean;
  sessionType: SessionType;
}

/** 7 days in milliseconds */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionPersistence {
  /**
   * Save Claude session metadata to disk via Obsidian's plugin data API.
   * Merges into existing plugin data under "persistedSessions" key.
   */
  static async saveToDisk(
    plugin: DataPlugin,
    sessions: Map<string, PersistableTab[]>
  ): Promise<void> {
    const persisted: PersistedSession[] = [];
    for (const [taskPath, tabs] of sessions) {
      for (const tab of tabs) {
        if (tab.isClaudeSession && tab.claudeSessionId) {
          persisted.push({
            version: 1,
            taskPath,
            claudeSessionId: tab.claudeSessionId,
            label: tab.label,
            sessionType: tab.sessionType,
            savedAt: new Date().toISOString(),
          });
        }
      }
    }

    const data = (await plugin.loadData()) || {};
    data.persistedSessions = persisted;
    await plugin.saveData(data);
    console.log("[work-terminal] Saved", persisted.length, "Claude sessions to disk");
  }

  /**
   * Load persisted Claude session metadata from disk.
   * Filters out sessions older than 7 days (Claude's default retention).
   */
  static async loadFromDisk(
    plugin: DataPlugin
  ): Promise<PersistedSession[]> {
    const data = (await plugin.loadData()) || {};
    const raw: PersistedSession[] = data.persistedSessions || [];
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    const valid = raw.filter(s => new Date(s.savedAt).getTime() > cutoff);
    if (valid.length !== raw.length) {
      console.log(
        "[work-terminal] Pruned",
        raw.length - valid.length,
        "stale persisted sessions"
      );
    }
    return valid;
  }

  /**
   * Clear persisted sessions from disk (e.g. after all have been resumed or are stale).
   */
  static async clearPersistedFromDisk(
    plugin: DataPlugin
  ): Promise<void> {
    const data = (await plugin.loadData()) || {};
    delete data.persistedSessions;
    await plugin.saveData(data);
  }
}
