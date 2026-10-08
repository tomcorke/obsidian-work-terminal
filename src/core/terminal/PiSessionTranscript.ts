import { electronRequire } from "../utils";

const MAX_TRANSCRIPT_LENGTH = 8_000;
const MAX_SESSION_FILE_LENGTH = 2_000_000;

interface PiSessionMapping {
  token: string;
  pid: number;
  sessionId: string;
  sessionFile?: string;
  state?: "active" | "idle";
  seq?: number;
  updatedAt: number;
}

export interface PiLifecycleReport {
  state: "active" | "idle";
  seq: number;
}

export interface PiLifecycleAuthority {
  accepted: boolean;
  state?: "active" | "idle";
  seq: number;
}

export function acceptPiLifecycleReport(
  current: PiLifecycleAuthority,
  report: PiLifecycleReport | null,
): PiLifecycleAuthority {
  if (!report || (current.accepted && report.seq <= current.seq)) return current;
  return { accepted: true, state: report.state, seq: report.seq };
}

interface SessionEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function prunePiSessionMappings(directory: string): void {
  const fs = electronRequire("fs") as typeof import("fs");
  const path = electronRequire("path") as typeof import("path");
  try {
    for (const name of fs.readdirSync(directory)) {
      const mappingPath = path.join(directory, name);
      try {
        const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8")) as PiSessionMapping;
        if (
          !Number.isInteger(mapping.pid) ||
          typeof mapping.updatedAt !== "number" ||
          !isProcessAlive(mapping.pid)
        ) {
          fs.rmSync(mappingPath, { force: true });
        }
      } catch {
        fs.rmSync(mappingPath, { force: true });
      }
    }
  } catch {
    // Directory does not exist yet or is unreadable.
  }
}

export function readPiLifecycleReport(
  mappingPath: string,
  expectedToken: string,
): PiLifecycleReport | null {
  const fs = electronRequire("fs") as typeof import("fs");
  try {
    const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8")) as PiSessionMapping;
    if (
      mapping.token !== expectedToken ||
      !Number.isSafeInteger(mapping.pid) ||
      mapping.pid <= 0 ||
      !isProcessAlive(mapping.pid) ||
      (mapping.state !== "active" && mapping.state !== "idle") ||
      !Number.isSafeInteger(mapping.seq) ||
      mapping.seq! < 0
    ) {
      return null;
    }
    return { state: mapping.state, seq: mapping.seq! };
  } catch {
    return null;
  }
}

export function readPiSessionTranscript(mappingPath: string, expectedToken: string): string | null {
  const fs = electronRequire("fs") as typeof import("fs");
  let mapping: PiSessionMapping;
  try {
    mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8")) as PiSessionMapping;
    if (
      mapping.token !== expectedToken ||
      !Number.isInteger(mapping.pid) ||
      typeof mapping.updatedAt !== "number" ||
      !isProcessAlive(mapping.pid)
    ) {
      fs.rmSync(mappingPath, { force: true });
      return null;
    }
    if (!mapping.sessionFile) return null;
  } catch {
    return null;
  }

  try {
    const stat = fs.statSync(mapping.sessionFile);
    const start = Math.max(0, stat.size - MAX_SESSION_FILE_LENGTH);
    const fd = fs.openSync(mapping.sessionFile, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const jsonl = buffer.toString("utf8");
      return parsePiSessionTranscript(start ? jsonl.slice(jsonl.indexOf("\n") + 1) : jsonl);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function parsePiSessionTranscript(jsonl: string): string | null {
  const entries: SessionEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Ignore an incomplete final append.
    }
  }

  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  const branch: SessionEntry[] = [];
  let current = [...entries].reverse().find((entry) => entry.id);
  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const text = branch
    .reverse()
    .filter((entry) => entry.type === "message")
    .flatMap((entry) => {
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") return [];
      const content = entry.message?.content;
      const value = Array.isArray(content)
        ? content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
        : typeof content === "string"
          ? content
          : "";
      return value.trim() ? [`${role === "user" ? "User" : "Assistant"}: ${value.trim()}`] : [];
    })
    .join("\n");

  return text ? text.slice(-MAX_TRANSCRIPT_LENGTH) : null;
}
