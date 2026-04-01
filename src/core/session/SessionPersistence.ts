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
import {
  isSessionType,
  type DurableRecoveryMode,
  type PersistedSession,
  type SessionType,
} from "./types";
import { PARAM_PASS_MODES, type ParamPassMode } from "../agents/AgentProfile";
import { mergeAndSavePluginData, type PluginDataStore } from "../PluginDataStore";

/** Tab-like interface for extracting persistable data. */
interface PersistableTab {
  label: string;
  taskPath: string | null;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string | null;
  isResumableAgent: boolean;
  sessionType: SessionType;
  launchShell: string;
  launchCwd: string;
  launchCommandArgs?: string[];
  profileId?: string;
  profileColor?: string;
  paramPassMode?: ParamPassMode;
}

/** 7 days in milliseconds */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default interval for periodic disk persist (30 seconds) */
export const PERSIST_INTERVAL_MS = 30_000;

export class SessionPersistence {
  private static buildPersistedSession(
    taskPath: string,
    tab: PersistableTab,
    savedAt: string,
  ): PersistedSession | null {
    const recoveryMode = this.getRecoveryMode(tab);
    if (!recoveryMode) {
      return null;
    }

    const claudeSessionId = tab.claudeSessionId ?? tab.agentSessionId ?? null;

    return {
      version: 2,
      taskPath,
      claudeSessionId,
      durableSessionId:
        recoveryMode === "relaunch"
          ? (tab.durableSessionId ?? globalThis.crypto.randomUUID())
          : undefined,
      label: tab.label,
      sessionType: tab.sessionType,
      savedAt,
      recoveryMode,
      cwd: tab.launchCwd,
      command: tab.launchCommandArgs?.[0] || tab.launchShell,
      commandArgs: tab.launchCommandArgs ? [...tab.launchCommandArgs] : undefined,
      profileId: tab.profileId,
      profileColor: tab.profileColor,
      paramPassMode: tab.paramPassMode,
    };
  }

  private static getRecoveryMode(tab: PersistableTab): DurableRecoveryMode | null {
    const claudeSessionId = tab.claudeSessionId ?? tab.agentSessionId ?? null;
    if (tab.isResumableAgent && claudeSessionId) {
      return "resume";
    }

    if (tab.launchCwd && (tab.launchCommandArgs?.length || tab.launchShell)) {
      return "relaunch";
    }

    return null;
  }

  private static normalizePersistedSession(raw: unknown): PersistedSession | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const candidate = raw as Record<string, unknown>;
    const taskPath = typeof candidate.taskPath === "string" ? candidate.taskPath : null;
    const label = typeof candidate.label === "string" ? candidate.label : null;
    const sessionType = isSessionType(candidate.sessionType) ? candidate.sessionType : null;
    const savedAt = typeof candidate.savedAt === "string" ? candidate.savedAt : null;

    if (!taskPath || !label || !sessionType || !savedAt) {
      return null;
    }

    // Support both legacy claudeSessionId and newer agentSessionId from disk
    const claudeSessionId =
      typeof candidate.claudeSessionId === "string"
        ? candidate.claudeSessionId
        : typeof candidate.agentSessionId === "string"
          ? candidate.agentSessionId
          : null;
    const durableSessionId =
      typeof candidate.durableSessionId === "string" ? candidate.durableSessionId : undefined;
    const durableSessionIdGenerated = candidate.durableSessionIdGenerated === true;
    const profileId = typeof candidate.profileId === "string" ? candidate.profileId : undefined;
    const profileColor =
      typeof candidate.profileColor === "string" ? candidate.profileColor : undefined;
    const paramPassMode = (PARAM_PASS_MODES as readonly string[]).includes(
      candidate.paramPassMode as string,
    )
      ? (candidate.paramPassMode as ParamPassMode)
      : undefined;
    const recoveryMode =
      candidate.recoveryMode === "resume" || candidate.recoveryMode === "relaunch"
        ? candidate.recoveryMode
        : claudeSessionId
          ? "resume"
          : null;
    const cwd = typeof candidate.cwd === "string" ? candidate.cwd : undefined;
    const command = typeof candidate.command === "string" ? candidate.command : undefined;
    const commandArgs = Array.isArray(candidate.commandArgs)
      ? candidate.commandArgs.filter((value): value is string => typeof value === "string")
      : undefined;

    if (!recoveryMode) {
      return null;
    }

    if (recoveryMode === "resume" && !claudeSessionId) {
      return null;
    }

    if (recoveryMode === "relaunch" && (!cwd || !command)) {
      return null;
    }

    const generatedDurableSessionId =
      recoveryMode === "relaunch" && !durableSessionId ? globalThis.crypto.randomUUID() : undefined;

    return {
      version: candidate.version === 1 ? 1 : 2,
      taskPath,
      claudeSessionId,
      durableSessionId:
        recoveryMode === "relaunch" ? durableSessionId || generatedDurableSessionId : undefined,
      durableSessionIdGenerated:
        recoveryMode === "relaunch" && (durableSessionIdGenerated || !!generatedDurableSessionId)
          ? true
          : undefined,
      label,
      sessionType,
      savedAt,
      recoveryMode,
      cwd,
      command,
      commandArgs,
      profileId,
      profileColor,
      paramPassMode,
    };
  }

  static buildPersistedSessions(sessions: Map<string, PersistableTab[]>): PersistedSession[] {
    const persisted: PersistedSession[] = [];
    const savedAt = new Date().toISOString();
    for (const [taskPath, tabs] of sessions) {
      for (const tab of tabs) {
        const session = this.buildPersistedSession(taskPath, tab, savedAt);
        if (session) {
          persisted.push(session);
        }
      }
    }
    return persisted;
  }

  private static getSessionKey(
    session: Pick<
      PersistedSession,
      | "taskPath"
      | "sessionType"
      | "claudeSessionId"
      | "durableSessionId"
      | "durableSessionIdGenerated"
      | "label"
      | "cwd"
      | "command"
      | "commandArgs"
      | "recoveryMode"
    >,
  ): string {
    if (session.recoveryMode === "resume") {
      return `resume:${session.claudeSessionId || ""}`;
    }

    if (session.durableSessionId) {
      return `relaunch:${session.taskPath}\u0001${session.durableSessionId}`;
    }

    const args = JSON.stringify(session.commandArgs || []);
    return [
      "relaunch",
      session.taskPath,
      session.sessionType,
      session.label,
      session.cwd || "",
      session.command || "",
      args,
    ].join("\u0001");
  }

  static mergePersistedSessions(
    existingPersisted: PersistedSession[],
    sessions: Map<string, PersistableTab[]>,
  ): PersistedSession[] {
    const activePersisted = this.buildPersistedSessions(sessions);
    const activeKeys = new Set(activePersisted.map((session) => this.getSessionKey(session)));
    return [
      ...activePersisted,
      ...existingPersisted.filter((session) => !activeKeys.has(this.getSessionKey(session))),
    ];
  }

  static setPersistedSessions(
    data: Record<string, any>,
    persistedSessions: PersistedSession[],
  ): void {
    data.persistedSessions = persistedSessions.map((session) => ({
      ...session,
      durableSessionIdGenerated: session.durableSessionIdGenerated ? true : undefined,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
    }));
  }

  /**
   * Save resumable session metadata to disk via Obsidian's plugin data API.
   * Merges into existing plugin data under "persistedSessions" key.
   */
  static async saveToDisk(
    plugin: PluginDataStore,
    sessions: Map<string, PersistableTab[]>,
    existingPersisted?: PersistedSession[],
  ): Promise<PersistedSession[]> {
    const persisted =
      existingPersisted !== undefined
        ? this.mergePersistedSessions(existingPersisted, sessions)
        : this.mergePersistedSessions(await this.loadFromDisk(plugin), sessions);
    await mergeAndSavePluginData(plugin, async (data) => {
      this.setPersistedSessions(data, persisted);
    });
    if (persisted.length > 0) {
      console.log("[work-terminal] Saved", persisted.length, "resumable sessions to disk");
    }
    return persisted;
  }

  /**
   * Load persisted resumable session metadata from disk.
   * Filters out sessions older than 7 days.
   */
  static async loadFromDisk(plugin: PluginDataStore): Promise<PersistedSession[]> {
    const data = (await plugin.loadData()) || {};
    const raw = Array.isArray(data.persistedSessions) ? data.persistedSessions : [];
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    const valid = raw
      .map((session) => this.normalizePersistedSession(session))
      .filter((session): session is PersistedSession => {
        return !!session && new Date(session.savedAt).getTime() > cutoff;
      });
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
