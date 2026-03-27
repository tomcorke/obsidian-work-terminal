/**
 * Monitor Claude CLI output for session rename events.
 *
 * Data may arrive split across chunks, so we buffer partial lines.
 * Uses StringDecoder to handle multi-byte UTF-8 characters (like the
 * box-drawing char in Claude's rename output) split across chunk boundaries.
 */
import { StringDecoder } from "string_decoder";
import { stripAnsi } from "../utils";

export class ClaudeSessionRename {
  private decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private renamePattern = /^\s*[^\w]*Session renamed to:\s*(.+?)\s*$/;

  /** Called when a rename is detected. */
  onRename?: (newLabel: string) => void;

  /** Optional hook for adapters to transform the detected label. */
  transformLabel?: (oldLabel: string, detected: string) => string;

  /**
   * Process a chunk of output data. Returns the detected new label, or null.
   */
  processChunk(data: Buffer): string | null {
    this.lineBuffer += this.decoder.write(data);
    // Split on any line ending style: \r\n, \n, or bare \r
    const lines = this.lineBuffer.split(/\r\n|\n|\r/);
    // Keep the last (possibly incomplete) chunk
    this.lineBuffer = lines.pop() || "";

    let detected: string | null = null;

    for (const line of lines) {
      const result = this._matchLine(line);
      if (result) detected = result;
    }

    // Also check the incomplete line buffer - handles the case where
    // rename output arrives without a trailing newline (e.g. Claude
    // goes straight back to waiting for input after /rename)
    if (this.lineBuffer) {
      const result = this._matchLine(this.lineBuffer);
      if (result) detected = result;
    }

    return detected;
  }

  private _matchLine(line: string): string | null {
    const clean = stripAnsi(line);
    const match = clean.match(this.renamePattern);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  /** Reset the internal buffer state. */
  reset(): void {
    this.lineBuffer = "";
    this.decoder = new StringDecoder("utf8");
  }
}
