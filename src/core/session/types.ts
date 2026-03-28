/**
 * Session type and persistence interfaces.
 */
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { ChildProcess } from "child_process";

export type SessionType =
  | "shell"
  | "claude"
  | "claude-with-context"
  | "copilot"
  | "copilot-with-context";

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
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  containerEl: HTMLElement;
  process: ChildProcess | null;
  webglAddon: WebglAddon | null;
  documentListeners: { event: string; handler: EventListener }[];
  resizeObserver: ResizeObserver;
}

/**
 * Lightweight metadata persisted to disk so Claude sessions can be resumed
 * after a full plugin close/restart (not just hot-reload).
 */
export interface PersistedSession {
  version: 1;
  taskPath: string;
  claudeSessionId: string;
  label: string;
  sessionType: SessionType;
  savedAt: string; // ISO timestamp
}

export interface StoredState {
  sessions: Map<string, StoredSession[]>;
  activeTaskPath: string | null;
  activeTabIndex: number;
}
