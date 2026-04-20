import { describe, expect, it, vi } from "vitest";
import {
  LOG_FILE_MAX_AGE_MS,
  LOG_FILE_MAX_COUNT,
  LOG_FILE_PREFIX,
  LOG_FILE_SUFFIX,
  buildLogFilename,
  formatEnrichmentLog,
  formatTimestampForFilename,
  resolveEnrichmentLogDir,
  selectLogsToPrune,
  writeEnrichmentLog,
} from "./EnrichmentLogger";

describe("formatTimestampForFilename", () => {
  it("pads components and includes milliseconds in UTC", () => {
    const date = new Date(Date.UTC(2026, 0, 5, 3, 7, 9, 42));
    expect(formatTimestampForFilename(date)).toBe("20260105-030709-042");
  });
});

describe("buildLogFilename", () => {
  const date = new Date(Date.UTC(2026, 3, 20, 14, 30, 0, 123));

  it("uses the titleHint slug when provided, with ms and random suffix", () => {
    const name = buildLogFilename(
      { category: "timeout", summary: "", titleHint: "Fix the Thing!" },
      date,
    );
    expect(name).toMatch(/^enrich-20260420-143000-123-fix-the-thing-[0-9a-f]{6}\.log$/);
  });

  it("falls back to the original filename without .md", () => {
    const name = buildLogFilename(
      {
        category: "timeout",
        summary: "",
        originalFilename: "TASK-20260420-1400-pending-abcd1234.md",
      },
      date,
    );
    expect(name).toContain("task-20260420-1400-pending-abcd1234");
    expect(name.endsWith(".log")).toBe(true);
  });

  it("falls back to item id if title and filename are missing", () => {
    const name = buildLogFilename({ category: "timeout", summary: "", itemId: "abc-123" }, date);
    expect(name).toContain("abc-123");
  });

  it("falls back to 'unknown' when no slug source is usable", () => {
    const name = buildLogFilename({ category: "timeout", summary: "" }, date);
    expect(name).toMatch(/^enrich-20260420-143000-123-unknown-[0-9a-f]{6}\.log$/);
  });

  it("produces unique filenames for repeated calls with identical params", () => {
    const params = { category: "timeout" as const, summary: "", titleHint: "Same Title" };
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(buildLogFilename(params, date));
    }
    // With 24 bits of random entropy and 20 draws, collision is extremely
    // unlikely; if this ever flakes it still indicates weak uniqueness.
    expect(names.size).toBe(20);
  });
});

describe("formatEnrichmentLog", () => {
  it("includes required fields and sections for a timeout with prompt and stderr", () => {
    const out = formatEnrichmentLog({
      timestamp: new Date(Date.UTC(2026, 3, 20, 14, 30, 0)),
      category: "timeout",
      summary: "Headless Claude timed out after 300s",
      itemId: "uuid-1",
      filePath: "2 - Areas/Tasks/todo/TASK-pending-01.md",
      prompt: "Enrich this task at /vault/file.md",
      stdout: "some partial output",
      stderr: "Headless Claude timed out after 300s",
      exitCode: -1,
      timeoutMs: 300000,
      command: "claude",
      args: "--allowedTools Edit",
      cwd: "/Users/t",
      agentName: "claude",
    });

    expect(out).toContain("# Work Terminal enrichment failure log");
    expect(out).toContain("timestamp: 2026-04-20T14:30:00.000Z");
    expect(out).toContain("category: timeout");
    expect(out).toContain("summary: Headless Claude timed out after 300s");
    expect(out).toContain("item_id: uuid-1");
    expect(out).toContain("file_path: 2 - Areas/Tasks/todo/TASK-pending-01.md");
    expect(out).toContain("exit_code: -1");
    expect(out).toContain("timeout_ms: 300000");
    expect(out).toContain("command: claude");
    expect(out).toContain("## prompt");
    expect(out).toContain("Enrich this task at /vault/file.md");
    expect(out).toContain("## stdout");
    expect(out).toContain("some partial output");
    expect(out).toContain("## stderr");
    expect(out).toContain("Headless Claude timed out after 300s");
  });

  it("formats Error instances with message and stack", () => {
    const err = new Error("spawn failed: ENOENT");
    const out = formatEnrichmentLog({
      category: "spawn-error",
      summary: "process spawn failed",
      error: err,
    });

    expect(out).toContain("## error");
    expect(out).toContain("spawn failed: ENOENT");
    // Stack trace contains the error message line; check node contains a file ref
    expect(out).toMatch(/at /);
  });

  it("formats string errors verbatim", () => {
    const out = formatEnrichmentLog({
      category: "other",
      summary: "string error",
      error: "literal error text",
    });
    expect(out).toContain("literal error text");
  });

  it("omits sections whose inputs are empty/undefined", () => {
    const out = formatEnrichmentLog({
      category: "non-zero-exit",
      summary: "exit 1",
    });
    expect(out).not.toContain("## prompt");
    expect(out).not.toContain("## stdout");
    expect(out).not.toContain("## stderr");
    expect(out).not.toContain("## error");
  });

  it("escapes triple-backtick sequences inside sections so the fence is not broken", () => {
    const out = formatEnrichmentLog({
      category: "other",
      summary: "with backticks",
      stdout: "before ``` after",
    });
    // Literal ``` inside the body should be interrupted; the only real fences
    // are the open/close ones.
    expect(out).not.toContain("before ``` after");
    expect(out.match(/```/g)?.length).toBe(2);
  });

  it("includes adapter_validation when present", () => {
    const out = formatEnrichmentLog({
      category: "pending-not-renamed",
      summary: "rename missing",
      adapterValidation: "pending file still exists after exit 0",
    });
    expect(out).toContain("adapter_validation: pending file still exists after exit 0");
  });
});

describe("selectLogsToPrune", () => {
  const now = Date.UTC(2026, 3, 20, 12, 0, 0);

  it("returns nothing when all logs are within retention", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `${LOG_FILE_PREFIX}20260419-00000${i}-x${LOG_FILE_SUFFIX}`,
      mtime: now - i * 1000,
    }));
    expect(selectLogsToPrune(entries, now)).toEqual([]);
  });

  it("prunes logs older than 7 days", () => {
    const entries = [
      { name: `${LOG_FILE_PREFIX}old-1${LOG_FILE_SUFFIX}`, mtime: now - LOG_FILE_MAX_AGE_MS - 1 },
      {
        name: `${LOG_FILE_PREFIX}old-2${LOG_FILE_SUFFIX}`,
        mtime: now - LOG_FILE_MAX_AGE_MS - 5000,
      },
      { name: `${LOG_FILE_PREFIX}recent${LOG_FILE_SUFFIX}`, mtime: now - 1000 },
    ];
    const pruned = selectLogsToPrune(entries, now);
    expect(pruned.sort()).toEqual(
      [
        `${LOG_FILE_PREFIX}old-1${LOG_FILE_SUFFIX}`,
        `${LOG_FILE_PREFIX}old-2${LOG_FILE_SUFFIX}`,
      ].sort(),
    );
  });

  it("caps the surviving count at LOG_FILE_MAX_COUNT, removing the oldest first", () => {
    const entries = Array.from({ length: LOG_FILE_MAX_COUNT + 3 }, (_, i) => ({
      name: `${LOG_FILE_PREFIX}entry-${String(i).padStart(3, "0")}${LOG_FILE_SUFFIX}`,
      mtime: now - (LOG_FILE_MAX_COUNT + 3 - i) * 1000,
    }));
    const pruned = selectLogsToPrune(entries, now);
    expect(pruned).toHaveLength(3);
    expect(pruned).toEqual([
      `${LOG_FILE_PREFIX}entry-000${LOG_FILE_SUFFIX}`,
      `${LOG_FILE_PREFIX}entry-001${LOG_FILE_SUFFIX}`,
      `${LOG_FILE_PREFIX}entry-002${LOG_FILE_SUFFIX}`,
    ]);
  });

  it("ignores files that are not enrichment logs", () => {
    const entries = [
      { name: `${LOG_FILE_PREFIX}fresh${LOG_FILE_SUFFIX}`, mtime: now - 1000 },
      { name: "data.json", mtime: now - LOG_FILE_MAX_AGE_MS - 1 },
      { name: "notes.md", mtime: now - LOG_FILE_MAX_AGE_MS - 1 },
    ];
    expect(selectLogsToPrune(entries, now)).toEqual([]);
  });
});

describe("resolveEnrichmentLogDir", () => {
  it("uses app.vault.configDir when available", () => {
    const app = { vault: { configDir: ".custom-config" } } as any;
    expect(resolveEnrichmentLogDir(app)).toBe(".custom-config/plugins/work-terminal/logs");
  });

  it("falls back to .obsidian when configDir is absent", () => {
    const app = { vault: {} } as any;
    expect(resolveEnrichmentLogDir(app)).toBe(".obsidian/plugins/work-terminal/logs");
  });

  it("supports a custom plugin id", () => {
    const app = { vault: { configDir: ".obsidian" } } as any;
    expect(resolveEnrichmentLogDir(app, "my-plugin")).toBe(".obsidian/plugins/my-plugin/logs");
  });
});

describe("writeEnrichmentLog", () => {
  function makeApp(overrides: Partial<Record<string, any>> = {}) {
    const writes: Array<{ path: string; body: string }> = [];
    const removes: string[] = [];
    const adapter = {
      mkdir: vi.fn(async () => {}),
      exists: vi.fn(async () => true),
      write: vi.fn(async (path: string, body: string) => {
        writes.push({ path, body });
      }),
      list: vi.fn(async () => ({ files: [] as string[], folders: [] as string[] })),
      stat: vi.fn(async () => ({ mtime: 0, ctime: 0, size: 0, type: "file" })),
      remove: vi.fn(async (path: string) => {
        removes.push(path);
      }),
      ...overrides,
    };
    const app = { vault: { configDir: ".obsidian", adapter } } as any;
    return { app, adapter, writes, removes };
  }

  it("writes a log file under the plugin logs directory", async () => {
    const { app, writes } = makeApp();
    await writeEnrichmentLog(app, {
      timestamp: new Date(Date.UTC(2026, 3, 20, 12, 0, 0, 456)),
      category: "timeout",
      summary: "timed out",
      titleHint: "My Task",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(
      /^\.obsidian\/plugins\/work-terminal\/logs\/enrich-20260420-120000-456-my-task-[0-9a-f]{6}\.log$/,
    );
    expect(writes[0].body).toContain("category: timeout");
  });

  it("still succeeds (no throw) when mkdir throws but directory exists", async () => {
    const { app, adapter, writes } = makeApp({
      mkdir: vi.fn(async () => {
        throw new Error("EEXIST");
      }),
      exists: vi.fn(async () => true),
    });
    await expect(
      writeEnrichmentLog(app, { category: "timeout", summary: "" }),
    ).resolves.toBeUndefined();
    expect(adapter.write).toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it("swallows adapter write errors rather than throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = makeApp({
        write: vi.fn(async () => {
          throw new Error("disk full");
        }),
      });
      await expect(
        writeEnrichmentLog(app, { category: "timeout", summary: "" }),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("removes log files that the pruner selects", async () => {
    const now = Date.UTC(2026, 3, 20, 12, 0, 0);
    const oldName = `${LOG_FILE_PREFIX}old${LOG_FILE_SUFFIX}`;
    const oldPath = `.obsidian/plugins/work-terminal/logs/${oldName}`;
    const { app, removes } = makeApp({
      list: vi.fn(async () => ({ files: [oldPath], folders: [] })),
      stat: vi.fn(async () => ({
        mtime: now - LOG_FILE_MAX_AGE_MS - 1000,
        ctime: 0,
        size: 0,
        type: "file",
      })),
    });

    await writeEnrichmentLog(app, {
      timestamp: new Date(now),
      category: "timeout",
      summary: "t",
    });

    expect(removes).toContain(oldPath);
  });
});
