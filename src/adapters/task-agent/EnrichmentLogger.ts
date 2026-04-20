/**
 * EnrichmentLogger - writes a detailed log file for each failed background
 * enrichment attempt. Logs are stored under the plugin directory's `logs/`
 * folder (resolved via Obsidian's vault adapter, not raw fs) so they sit
 * alongside plugin data without leaking into the vault's visible notes.
 *
 * The formatter (`formatEnrichmentLog`) is separated from the writer
 * (`writeEnrichmentLog`) so tests can validate log output without depending
 * on the Obsidian API.
 *
 * Log retention: on every write the pruner removes logs older than 7 days
 * and caps the total log count at 50 files, whichever is stricter. The
 * writer is best-effort: if the plugin directory is unwritable, it falls
 * back to `console.error` rather than allowing enrichment failure handling
 * to cascade into a second failure.
 */
import type { App } from "obsidian";
import { slugify } from "../../core/utils";

/** Maximum number of log files kept on disk. */
export const LOG_FILE_MAX_COUNT = 50;

/** Maximum log age in milliseconds (7 days). */
export const LOG_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Prefix applied to log files so the pruner can identify them. */
export const LOG_FILE_PREFIX = "enrich-";

/** Suffix applied to log files. */
export const LOG_FILE_SUFFIX = ".log";

/**
 * Category of enrichment failure, recorded for at-a-glance classification
 * when scanning a directory of logs.
 */
export type EnrichmentFailureCategory =
  | "timeout"
  | "missing-cli"
  | "non-zero-exit"
  | "silent-failure"
  | "pending-not-renamed"
  | "moved-during-enrichment"
  | "spawn-error"
  | "adapter-validation"
  | "missing-frontmatter"
  | "other";

/** Inputs used to build a log entry. The writer never mutates these. */
export interface EnrichmentLogParams {
  /** UTC timestamp for the failure (defaults to new Date()). */
  timestamp?: Date;
  /** Item UUID from frontmatter. */
  itemId?: string;
  /** Vault-relative path of the task file at failure time. */
  filePath?: string;
  /** Original filename for the task (helps when the file has been moved). */
  originalFilename?: string;
  /** Short title/slug used to make the log filename more scannable. */
  titleHint?: string;
  /** Failure category. */
  category: EnrichmentFailureCategory;
  /** Human-readable one-line summary of the failure. */
  summary: string;
  /** The prompt that was sent to the agent. */
  prompt?: string;
  /** Captured stdout from the agent process. */
  stdout?: string;
  /** Captured stderr from the agent process. */
  stderr?: string;
  /** Process exit code, when applicable. */
  exitCode?: number;
  /** Error instance or string, when a JS exception was raised. */
  error?: unknown;
  /** Adapter validation details (e.g. "pending file was not renamed"). */
  adapterValidation?: string;
  /** Agent command invoked (for debugging which binary was used). */
  command?: string;
  /** Extra arguments passed to the agent. */
  args?: string;
  /** Working directory the agent was launched in. */
  cwd?: string;
  /** Agent name / profile label (e.g. "claude", "pi", "copilot"). */
  agentName?: string;
  /** Timeout (ms) configured for the enrichment run. */
  timeoutMs?: number;
}

/**
 * Format a timestamp as `YYYYMMDD-HHMMSS-sss` in UTC. Used in log filenames so
 * chronological sort order matches lexicographic sort. Milliseconds are
 * included to reduce the chance of collisions when multiple failures occur in
 * the same second (e.g. two tasks with the same title hint).
 */
export function formatTimestampForFilename(date: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `-${pad(date.getUTCMilliseconds(), 3)}`
  );
}

/**
 * Generate a short random hex token (default 6 hex chars = 24 bits of entropy).
 * Used as a final collision guard on log filenames: even if two failures share
 * the same millisecond timestamp and title, the random suffix effectively
 * eliminates collisions in practice.
 */
export function randomFilenameToken(length = 6): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Build the log filename for an enrichment failure:
 * `enrich-<ts>-<slug>-<rand>.log`. Falls back to "unknown" when no usable
 * title/filename is available. The millisecond-precision timestamp plus a
 * short random token ensure two failures with the same title in the same
 * second still produce distinct filenames.
 */
export function buildLogFilename(params: EnrichmentLogParams, date: Date): string {
  const tsPart = formatTimestampForFilename(date);
  const raw =
    params.titleHint ||
    (params.originalFilename ? params.originalFilename.replace(/\.md$/i, "") : "") ||
    params.itemId ||
    "unknown";
  const slug = slugify(raw) || "unknown";
  const rand = randomFilenameToken();
  return `${LOG_FILE_PREFIX}${tsPart}-${slug}-${rand}${LOG_FILE_SUFFIX}`;
}

/**
 * Produce the textual body of a log file. Pure function: no I/O, no globals.
 * The output is a short preamble with key=value fields followed by fenced
 * sections for prompt / stdout / stderr / error when present.
 */
export function formatEnrichmentLog(params: EnrichmentLogParams): string {
  const ts = (params.timestamp ?? new Date()).toISOString();
  const lines: string[] = [];

  lines.push(`# Work Terminal enrichment failure log`);
  lines.push(`timestamp: ${ts}`);
  lines.push(`category: ${params.category}`);
  lines.push(`summary: ${params.summary}`);
  if (params.itemId) lines.push(`item_id: ${params.itemId}`);
  if (params.filePath) lines.push(`file_path: ${params.filePath}`);
  if (params.originalFilename && params.originalFilename !== params.filePath) {
    lines.push(`original_filename: ${params.originalFilename}`);
  }
  if (params.agentName) lines.push(`agent: ${params.agentName}`);
  if (params.command) lines.push(`command: ${params.command}`);
  if (params.args) lines.push(`args: ${params.args}`);
  if (params.cwd) lines.push(`cwd: ${params.cwd}`);
  if (typeof params.timeoutMs === "number") lines.push(`timeout_ms: ${params.timeoutMs}`);
  if (typeof params.exitCode === "number") lines.push(`exit_code: ${params.exitCode}`);
  if (params.adapterValidation) {
    lines.push(`adapter_validation: ${params.adapterValidation}`);
  }

  const appendSection = (title: string, body: string | undefined): void => {
    if (!body) return;
    lines.push("");
    lines.push(`## ${title}`);
    lines.push("```");
    lines.push(body.replace(/\r\n/g, "\n").replace(/```/g, "``\u200b`"));
    lines.push("```");
  };

  appendSection("prompt", params.prompt);
  appendSection("stdout", params.stdout);
  appendSection("stderr", params.stderr);

  if (params.error !== undefined && params.error !== null) {
    const err = params.error as { message?: string; stack?: string } | string;
    let errorBody: string;
    if (typeof err === "string") {
      errorBody = err;
    } else {
      const msg = err.message || String(err);
      errorBody = err.stack ? `${msg}\n${err.stack}` : msg;
    }
    appendSection("error", errorBody);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Select filenames that should be pruned to honour the retention policy.
 * Takes the current listing (name + mtime) and the reference `now`.
 * Returns filenames (without directory prefix) that should be deleted.
 *
 * Rules, applied in order:
 * 1. Anything older than LOG_FILE_MAX_AGE_MS is pruned.
 * 2. After age-pruning, if more than LOG_FILE_MAX_COUNT remain, the oldest
 *    entries (by mtime) are pruned until the count is under the cap.
 *
 * Pure function; safe to call from tests.
 */
export function selectLogsToPrune(
  entries: ReadonlyArray<{ name: string; mtime: number }>,
  now: number,
): string[] {
  const enrichLogs = entries.filter(
    (e) => e.name.startsWith(LOG_FILE_PREFIX) && e.name.endsWith(LOG_FILE_SUFFIX),
  );

  const expired = new Set<string>();
  const cutoff = now - LOG_FILE_MAX_AGE_MS;
  for (const e of enrichLogs) {
    if (e.mtime < cutoff) expired.add(e.name);
  }

  const remaining = enrichLogs
    .filter((e) => !expired.has(e.name))
    .sort((a, b) => a.mtime - b.mtime);

  const overflow = Math.max(0, remaining.length - LOG_FILE_MAX_COUNT);
  const overCap = remaining.slice(0, overflow).map((e) => e.name);

  return [...expired, ...overCap];
}

/**
 * Resolve the vault-relative directory where enrichment logs are stored.
 * Uses `app.vault.configDir` so it matches wherever Obsidian is currently
 * storing `.obsidian/*` on this system.
 */
export function resolveEnrichmentLogDir(app: App, pluginId = "work-terminal"): string {
  const configDir = app.vault.configDir || ".obsidian";
  return `${configDir}/plugins/${pluginId}/logs`;
}

/**
 * Write a log file for a failed enrichment attempt, then prune old files.
 * Never throws: if any Obsidian adapter call fails, the error is forwarded
 * to `console.error` and the caller continues unaffected.
 */
export async function writeEnrichmentLog(
  app: App,
  params: EnrichmentLogParams,
  options: { pluginId?: string } = {},
): Promise<void> {
  const timestamp = params.timestamp ?? new Date();
  const dir = resolveEnrichmentLogDir(app, options.pluginId ?? "work-terminal");
  const filename = buildLogFilename(params, timestamp);
  const fullPath = `${dir}/${filename}`;
  const body = formatEnrichmentLog({ ...params, timestamp });

  try {
    const adapter = app.vault.adapter;
    // Ensure logs directory exists. mkdir is idempotent in Obsidian's adapter.
    try {
      await adapter.mkdir(dir);
    } catch (mkdirErr) {
      // Some adapters throw if the directory already exists; ignore those.
      const exists = await adapter.exists(dir).catch(() => false);
      if (!exists) throw mkdirErr;
    }
    await adapter.write(fullPath, body);

    // Prune old logs. Failures here should not bubble up.
    try {
      await pruneEnrichmentLogs(app, dir, timestamp.getTime());
    } catch (pruneErr) {
      console.error("[work-terminal] Enrichment log pruning failed:", pruneErr);
    }
  } catch (err) {
    console.error(
      `[work-terminal] Failed to write enrichment log to ${fullPath}. ` +
        `Log body:\n${body}\nReason:`,
      err,
    );
  }
}

/**
 * List log files and delete those selected by `selectLogsToPrune`. Exported
 * for direct use only by the writer and tests.
 */
export async function pruneEnrichmentLogs(app: App, dir: string, now: number): Promise<void> {
  const adapter = app.vault.adapter;
  const listing = await adapter.list(dir);
  const entries: { name: string; mtime: number }[] = [];
  for (const filePath of listing.files) {
    const name = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (!name.startsWith(LOG_FILE_PREFIX) || !name.endsWith(LOG_FILE_SUFFIX)) continue;
    const stat = await adapter.stat(filePath).catch(() => null);
    // Skip entries with unreadable metadata rather than treating them as
    // mtime=0 (which would cause the pruner to aggressively delete valid
    // logs on transient stat failures). Files whose stat fails stay put
    // until they can be re-listed successfully on a later pass.
    if (!stat || typeof stat.mtime !== "number") continue;
    entries.push({ name, mtime: stat.mtime });
  }
  const toPrune = selectLogsToPrune(entries, now);
  for (const name of toPrune) {
    await adapter.remove(`${dir}/${name}`).catch((err: unknown) => {
      console.error(`[work-terminal] Failed to remove old enrichment log ${name}:`, err);
    });
  }
}
