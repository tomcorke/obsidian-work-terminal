/**
 * Disk persistence for resumable agent session metadata.
 *
 * Saves/loads session metadata via Obsidian's plugin data API so supported
 * agent sessions can be resumed after a full plugin close/restart (not just
 * hot-reload). Uses a merge pattern to avoid clobbering other plugin data
 * (settings, taskOrder, etc.) stored in the same data.json file.
 *
 * Sessions older than 7 days are pruned on load.
 */
import type { PersistedSession, SessionType } from "./types";
import { mergeAndSavePluginData, type PluginDataStore } from "../PluginDataStore";

/** Tab-like interface for extracting persistable data. */
interface PersistableTab {
  label: string;
  taskPath: string | null;
  claudeSessionId: string | null;
  isResumableAgent: boolean;
  sessionType: SessionType;
}

/** 7 days in milliseconds */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default interval for periodic disk persist (30 seconds) */
export const PERSIST_INTERVAL_MS = 30_000;

export class SessionPersistence {
  static buildPersistedSessions(sessions: Map<string, PersistableTab[]>): PersistedSession[] {
    const persisted: PersistedSession[] = [];
    for (const [taskPath, tabs] of sessions) {
      for (const tab of tabs) {
        if (tab.isResumableAgent && tab.claudeSessionId) {
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
    return persisted;
  }

  static setPersistedSessions(
    data: Record<string, any>,
    sessions: Map<string, PersistableTab[]>,
  ): void {
    data.persistedSessions = this.buildPersistedSessions(sessions);
  }

  /**
   * Save resumable session metadata to disk via Obsidian's plugin data API.
   * Merges into existing plugin data under "persistedSessions" key.
   */
  static async saveToDisk(
    plugin: PluginDataStore,
    sessions: Map<string, PersistableTab[]>,
  ): Promise<void> {
    let persisted: PersistedSession[] = [];
    await mergeAndSavePluginData(plugin, async (data) => {
      this.setPersistedSessions(data, sessions);
      persisted = data.persistedSessions as PersistedSession[];
    });
    if (persisted.length > 0) {
      console.log("[work-terminal] Saved", persisted.length, "resumable sessions to disk");
    }
  }

  /**
   * Load persisted resumable session metadata from disk.
   * Filters out sessions older than 7 days.
   */
  static async loadFromDisk(plugin: PluginDataStore): Promise<PersistedSession[]> {
    const data = (await plugin.loadData()) || {};
    const raw: PersistedSession[] = data.persistedSessions || [];
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    const valid = raw.filter((s) => new Date(s.savedAt).getTime() > cutoff);
    if (valid.length !== raw.length) {
      console.log("[work-terminal] Pruned", raw.length - valid.length, "stale persisted sessions");
    }
    return valid;
  }

  /**
   * Clear persisted sessions from disk (e.g. after all have been resumed or are stale).
   */
  static async clearPersistedFromDisk(plugin: PluginDataStore): Promise<void> {
    await mergeAndSavePluginData(plugin, async (data) => {
      delete data.persistedSessions;
    });
  }

  /**
   * Start a periodic persist interval as a safety net. Returns a stop function.
   * If the async persist callback fails, errors are logged but don't break the interval.
   */
  static startPeriodicPersist(
    persistFn: () => Promise<void>,
    intervalMs: number = 30_000,
  ): () => void {
    let isPersisting = false;
    const id = setInterval(() => {
      if (isPersisting) return;
      isPersisting = true;
      persistFn()
        .catch((err) => console.error("[work-terminal] Periodic persist failed:", err))
        .finally(() => {
          isPersisting = false;
        });
    }, intervalMs);
    return () => clearInterval(id);
  }
}
