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
import {
  type ParamPassMode,
  sessionTypeToAgentType,
  isResumableAgentType,
  isProfileSessionType,
} from "../agents/AgentProfile";

export const KNOWN_SESSION_TYPES = [
  "shell",
  "claude",
  "claude-with-context",
  "copilot",
  "copilot-with-context",
  "strands",
  "strands-with-context",
  "custom",
] as const;

/** @deprecated Use KNOWN_SESSION_TYPES instead. */
export const SESSION_TYPES = KNOWN_SESSION_TYPES;

export type KnownSessionType = (typeof KNOWN_SESSION_TYPES)[number];
export type ProfileSessionType = `profile:${string}`;

/**
 * Session type identifier. Known types are the literal strings in KNOWN_SESSION_TYPES.
 * Custom agent profiles use "profile:<uuid>" session types.
 */
export type SessionType = KnownSessionType | ProfileSessionType;

export type DurableRecoveryMode = "resume" | "relaunch";

export type AgentRuntimeState = "inactive" | "active" | "idle" | "waiting";

/**
 * State extracted from a TerminalTab that can survive a plugin hot-reload.
 * Stored on window.__workTerminalStore which persists across module re-evaluations.
 */
export interface StoredSession {
  id: string;
  taskPath: string | null;
  label: string;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string | null;
  sessionType: SessionType;
  profileId?: string;
  profileColor?: string;
  paramPassMode?: ParamPassMode;
  /** Activity detection patterns for config-driven state detection. */
  activityPatterns?: { activeLinePatterns: RegExp[]; activeJoinedPatterns: RegExp[] };
  /** Explicit resumable override for custom profiles. */
  isResumableOverride?: boolean;
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
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string;
  durableSessionIdGenerated?: boolean;
  label: string;
  sessionType: SessionType;
  savedAt: string; // ISO timestamp
  recoveryMode?: DurableRecoveryMode;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
  profileId?: string;
  profileColor?: string;
  paramPassMode?: ParamPassMode;
}

export interface ActiveTabInfo {
  tabId: string;
  itemId: string;
  label: string;
  sessionId: string | null;
  sessionType: SessionType;
  isResumableAgent: boolean;
}

export interface TabProcessDiagnostics {
  pid: number | null;
  status: "missing" | "alive" | "exited" | "killed";
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  spawnTime: number | null;
  uptimeMs: number | null;
}

export interface TabRendererDiagnostics {
  canvasCount: number;
  hasRenderableContent: boolean;
  hasBlankRenderSurface: boolean;
  trackedWebglAddonPresent: boolean;
  trackedWebglAddonDisposed: boolean;
  webglSuspended: boolean;
  staleDisposedWebglOwnership: boolean;
}

export interface TabBufferDiagnostics {
  screenLineCount: number;
  screenTail: string[];
}

export interface TerminalTabDiagnostics {
  tabId: string;
  label: string;
  sessionId: string | null;
  sessionType: SessionType;
  claudeState: AgentRuntimeState;
  isResumableAgent: boolean;
  isVisible: boolean;
  isDisposed: boolean;
  process: TabProcessDiagnostics;
  renderer: TabRendererDiagnostics;
  buffer: TabBufferDiagnostics;
  derived: {
    blankButLiveRenderer: boolean;
    staleDisposedWebglOwnership: boolean;
  };
}

export interface TabDiagnostics extends TerminalTabDiagnostics {
  itemId: string;
  tabIndex: number;
  isSelected: boolean;
  recovery: {
    resumable: boolean;
    relaunchable: boolean;
    hasPersistedSession: boolean;
    canResumeAfterRestart: boolean;
    missingPersistedMetadata: boolean;
    wouldBeLostOnFullClose: boolean;
    lifecycle: "live" | "disposed" | "resumable" | "resume-metadata-missing" | "lost";
  };
  derived: TerminalTabDiagnostics["derived"] & {
    disposedTabStillSelected: boolean;
  };
}

export interface StoredState {
  sessions: Map<string, StoredSession[]>;
  activeTaskPath: string | null;
  activeTabIndex: number;
}

export function isSessionType(value: unknown): value is SessionType {
  return (
    typeof value === "string" &&
    (KNOWN_SESSION_TYPES.includes(value as (typeof KNOWN_SESSION_TYPES)[number]) ||
      isProfileSessionType(value))
  );
}

export function isResumableSessionType(sessionType: SessionType): boolean {
  const { agentType } = sessionTypeToAgentType(sessionType);
  return isResumableAgentType(agentType);
}
