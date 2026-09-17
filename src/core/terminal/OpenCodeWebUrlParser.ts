import { stripAnsi } from "../utils";

const URL_PATTERN = /https?:\/\/[^\s\x1b<>"']+/gi;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function extractLoopbackUrl(output: string): string | null {
  for (const match of stripAnsi(output).matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      if (LOOPBACK_HOSTS.has(url.hostname)) return url.href;
    } catch {
      // Keep scanning output for another URL.
    }
  }
  return null;
}

export class OpenCodeWebUrlParser {
  private outputTail = "";

  push(chunk: Buffer | string): string | null {
    this.outputTail = `${this.outputTail}${chunk.toString()}`.slice(-8192);
    return extractLoopbackUrl(this.outputTail);
  }
}
