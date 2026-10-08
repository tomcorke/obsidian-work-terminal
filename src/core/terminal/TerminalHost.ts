import { StringDecoder } from "string_decoder";
import type { SessionType } from "../session/types";
import { stripAnsi } from "../utils";

export const TERMINAL_OUTPUT_MAX_BYTES = 256 * 1024;
export const TERMINAL_OUTPUT_MAX_LINES = 2_000;

export type TerminalHostRuntimeState = "active" | "idle" | "waiting" | "unknown";
export type TerminalHostProcessStatus = "running" | "exited";
export type TerminalHostCommandResult = "accepted" | "exited" | "unavailable";

export interface TerminalTabTarget {
  readonly taskId: string;
  readonly tabId: string;
  readonly generation: number;
}

export interface TerminalTabHostSnapshot extends TerminalTabTarget {
  readonly label: string;
  readonly sessionType: SessionType;
  readonly profileId?: string;
  readonly state: TerminalHostRuntimeState;
  readonly processStatus: TerminalHostProcessStatus;
  readonly latestSequence: string;
}

export interface CleanOutputRead {
  readonly text: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly truncated: boolean;
}

export type TerminalLifecycleEvent =
  | Readonly<{
      type: "state";
      target: TerminalTabTarget;
      state: TerminalHostRuntimeState;
      sequence: string;
    }>
  | Readonly<{
      type: "exit";
      target: TerminalTabTarget;
      exitCode: number | null;
      signal: string | null;
      sequence: string;
    }>;

export type TerminalLifecycleListener = (event: TerminalLifecycleEvent) => void;

function incrementDecimal(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] === "9") {
      digits[index] = "0";
      continue;
    }
    digits[index] = String(Number(digits[index]) + 1);
    return digits.join("");
  }
  return `1${digits.join("")}`;
}

function trimUtf8Start(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** Runtime-only terminal state retained when the same live tab is rewrapped on reload. */
export class TerminalHostBridge {
  private readonly decoder = new StringDecoder("utf8");
  private lines: string[] = [];
  private pendingRaw = "";
  private droppedOutput = false;
  private sequence = "0";
  private listeners = new Set<TerminalLifecycleListener>();
  private target: TerminalTabTarget | null = null;

  onProcessExit?: (code: number | null, signal: string | null) => void;
  onStateChange?: (state: "inactive" | "active" | "idle" | "waiting") => void;

  appendOutput(data: Buffer | string): void {
    this.pendingRaw += typeof data === "string" ? data : this.decoder.write(data);
    const parts = this.pendingRaw.split(/\r\n|\n|\r/);
    this.pendingRaw = parts.pop() ?? "";
    this.lines.push(...parts.map(stripAnsi));

    if (Buffer.byteLength(this.pendingRaw) > TERMINAL_OUTPUT_MAX_BYTES) {
      this.pendingRaw = trimUtf8Start(this.pendingRaw, TERMINAL_OUTPUT_MAX_BYTES);
      this.droppedOutput = true;
    }
    this.enforceBounds();
  }

  readOutput(options: { maxLines: number; maxBytes: number }): CleanOutputRead {
    const available = [...this.lines];
    if (this.pendingRaw) available.push(stripAnsi(this.pendingRaw));

    const selected = available.slice(-options.maxLines);
    let truncated = this.droppedOutput || selected.length < available.length;
    while (selected.length > 1 && Buffer.byteLength(selected.join("\n")) > options.maxBytes) {
      selected.shift();
      truncated = true;
    }
    if (selected.length === 1 && Buffer.byteLength(selected[0]) > options.maxBytes) {
      selected[0] = trimUtf8Start(selected[0], options.maxBytes);
      truncated = true;
    }

    const text = selected.join("\n");
    return Object.freeze({
      text,
      lineCount: selected.length,
      byteCount: Buffer.byteLength(text),
      truncated,
    });
  }

  latestSequence(): string {
    return this.sequence;
  }

  setTarget(target: TerminalTabTarget): void {
    this.target = Object.freeze({ ...target });
  }

  subscribe(listener: TerminalLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  emitState(state: TerminalHostRuntimeState): void {
    if (!this.target) return;
    this.emit({ type: "state", target: this.target, state, sequence: this.nextSequence() });
  }

  emitExit(exitCode: number | null, signal: string | null): void {
    if (!this.target) return;
    this.emit({
      type: "exit",
      target: this.target,
      exitCode,
      signal,
      sequence: this.nextSequence(),
    });
  }

  private enforceBounds(): void {
    const logicalLineCount = this.lines.length + (this.pendingRaw ? 1 : 0);
    if (logicalLineCount > TERMINAL_OUTPUT_MAX_LINES) {
      this.lines.splice(0, logicalLineCount - TERMINAL_OUTPUT_MAX_LINES);
      this.droppedOutput = true;
    }

    while (this.totalByteLength() > TERMINAL_OUTPUT_MAX_BYTES && this.lines.length > 1) {
      this.lines.shift();
      this.droppedOutput = true;
    }
    if (this.totalByteLength() <= TERMINAL_OUTPUT_MAX_BYTES) return;

    if (this.lines.length === 1) {
      const pendingBytes = this.pendingRaw ? Buffer.byteLength(this.pendingRaw) + 1 : 0;
      this.lines[0] = trimUtf8Start(
        this.lines[0],
        Math.max(0, TERMINAL_OUTPUT_MAX_BYTES - pendingBytes),
      );
    } else {
      this.pendingRaw = trimUtf8Start(this.pendingRaw, TERMINAL_OUTPUT_MAX_BYTES);
    }
    this.droppedOutput = true;
  }

  private totalByteLength(): number {
    const cleanPending = this.pendingRaw ? stripAnsi(this.pendingRaw) : "";
    return Buffer.byteLength([...this.lines, ...(cleanPending ? [cleanPending] : [])].join("\n"));
  }

  private nextSequence(): string {
    this.sequence = incrementDecimal(this.sequence);
    return this.sequence;
  }

  private emit(event: TerminalLifecycleEvent): void {
    const frozenTarget = Object.freeze({ ...event.target });
    const frozenEvent = Object.freeze({ ...event, target: frozenTarget }) as TerminalLifecycleEvent;
    for (const listener of [...this.listeners]) listener(frozenEvent);
  }
}
