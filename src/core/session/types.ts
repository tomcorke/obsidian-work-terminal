/**
 * Session type and persistence interfaces.
 */
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ChildProcess } from "child_process";

export const SESSION_TYPES = [
  "shell",
  "claude",
  "claude-with-context",
  "copilot",
  "copilot-with-context",
  "strands",
  "strands-with-context",
] as const;

export type SessionType = (typeof SESSION_TYPES)[number];

export type DurableRecoveryMode = "resume" | "relaunch";

/**
 * State extracted from a TerminalTab that can survive a plugin hot-reload.
 * Stored on window.__workTerminalStore which persists across module re-evaluations.
 */
export interface StoredSession {
  id: string;
  taskPath: string | null;
  label: string;
  claudeSessionId: string | null;
  sessionType: SessionType;
  shell?: string;
  cwd?: string;
  commandArgs?: string[];
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webLinksAddon?: WebLinksAddon;
  linkProviderDisposable?: IDisposable | null;
  unicode11Addon?: Unicode11Addon;
  webglAddon?: WebglAddon | null;
  webglContextLossListener?: IDisposable | null;
  containerEl: HTMLElement;
  process: ChildProcess | null;
  documentListeners: { event: string; handler: EventListener }[];
  resizeObserver: ResizeObserver;
}

/**
 * Lightweight metadata persisted to disk so resumable agent sessions can be
 * resumed after a full plugin close/restart (not just hot-reload).
 */
export interface PersistedSession {
  version: 1 | 2;
  taskPath: string;
  claudeSessionId?: string | null;
  label: string;
  sessionType: SessionType;
  savedAt: string; // ISO timestamp
  recoveryMode?: DurableRecoveryMode;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
}

export interface ActiveTabInfo {
  tabId: string;
  itemId: string;
  label: string;
  sessionId: string | null;
  sessionType: SessionType;
  isResumableAgent: boolean;
}

export interface StoredState {
  sessions: Map<string, StoredSession[]>;
  activeTaskPath: string | null;
  activeTabIndex: number;
}

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === "string" && SESSION_TYPES.includes(value as SessionType);
}

export function isResumableSessionType(sessionType: SessionType): boolean {
  return (
    sessionType === "claude" ||
    sessionType === "claude-with-context" ||
    sessionType === "copilot" ||
    sessionType === "copilot-with-context"
  );
}
