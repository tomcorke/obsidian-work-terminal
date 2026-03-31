const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const DEFAULT_DEBUG_PORT = 9222;
const ISOLATED_PORT_BASE = 9300;
const ISOLATED_PORT_RANGE = 100;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 10_000;
const OBSIDIAN_BINARY =
  process.env.OBSIDIAN_BINARY || "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const DEFAULT_SELECTOR_PADDING = 12;
const DEFAULT_VAULT_DIR = path.join(".claude", "testing", "obsidian-vault");
const DEFAULT_SCREENSHOT_PATH = path.join("output", "obsidian-screenshot.png");
const ISOLATED_VAULT_MARKER = ".work-terminal-test-vault.json";
const WORK_TERMINAL_PLUGIN_ID = "work-terminal";
const WORK_TERMINAL_COMMAND_IDS = {
  reload: "work-terminal:reload-plugin",
  openView: "work-terminal:open-work-terminal",
};

function getDefaultPort() {
  const raw = process.env.OBSIDIAN_REMOTE_DEBUG_PORT || process.env.CDP_PORT || String(DEFAULT_DEBUG_PORT);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_DEBUG_PORT;
}

function ensureInteger(value, flagName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flagName} must be an integer`);
  }
  return parsed;
}

function resolvePath(cwd, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
}

function isSubpath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseSharedFlags(argv, cwd) {
  const options = {
    host: DEFAULT_HOST,
    port: getDefaultPort(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    selector: undefined,
    selectorPadding: DEFAULT_SELECTOR_PADDING,
    fullPage: false,
    vaultDir: resolvePath(cwd, DEFAULT_VAULT_DIR),
    pluginDir: undefined,
    clean: false,
    force: false,
    openView: true,
    sampleData: true,
    hide: true,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--host":
        options.host = requireFlagValue(argv, i, "--host");
        i += 1;
        break;
      case "--port":
        options.port = ensureInteger(argv[i + 1], "--port");
        i += 1;
        break;
      case "--timeout":
        options.timeoutMs = ensureInteger(argv[i + 1], "--timeout");
        i += 1;
        break;
      case "--selector":
        options.selector = argv[i + 1] || "";
        i += 1;
        break;
      case "--padding":
        options.selectorPadding = ensureInteger(argv[i + 1], "--padding");
        i += 1;
        break;
      case "--full-page":
        options.fullPage = true;
        break;
      case "--vault":
        options.vaultDir = resolvePath(cwd, requireFlagValue(argv, i, "--vault"));
        i += 1;
        break;
      case "--plugin-dir":
        options.pluginDir = resolvePath(cwd, requireFlagValue(argv, i, "--plugin-dir"));
        i += 1;
        break;
      case "--clean":
        options.clean = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--no-open-view":
        options.openView = false;
        break;
      case "--no-sample-data":
        options.sampleData = false;
        break;
      case "--no-hide":
        options.hide = false;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  return { options, positional };
}

function parseCdpArgs(argv, cwd = process.cwd()) {
  const { options, positional } = parseSharedFlags(argv, cwd);
  const [commandName, ...rest] = positional;

  if (!commandName) {
    return { ...options, command: "reload" };
  }

  const knownCommands = new Set(["reload", "open-view", "eval", "wait-for", "click", "type", "screenshot"]);
  if (!knownCommands.has(commandName)) {
    return {
      ...options,
      command: "eval",
      expression: [commandName, ...rest].join(" "),
    };
  }

  switch (commandName) {
    case "reload":
    case "open-view":
      return { ...options, command: commandName };
    case "eval": {
      const expression = rest.join(" ").trim();
      if (!expression) throw new Error("eval requires a JavaScript expression");
      return { ...options, command: "eval", expression };
    }
    case "wait-for": {
      const selector = rest[0] || options.selector;
      if (!selector) throw new Error("wait-for requires a selector");
      return { ...options, command: "wait-for", selector };
    }
    case "click": {
      const selector = rest[0] || options.selector;
      if (!selector) throw new Error("click requires a selector");
      return { ...options, command: "click", selector };
    }
    case "type": {
      const selector = rest[0] || options.selector;
      const text = rest.slice(1).join(" ");
      if (!selector) throw new Error("type requires a selector");
      if (!text) throw new Error("type requires text");
      return { ...options, command: "type", selector, text };
    }
    case "screenshot": {
      const outputPath = resolvePath(cwd, rest[0] || DEFAULT_SCREENSHOT_PATH);
      return { ...options, command: "screenshot", outputPath };
    }
    default:
      throw new Error(`Unsupported command: ${commandName}`);
  }
}

function parseIsolatedInstanceArgs(argv, cwd = process.cwd()) {
  const { options, positional } = parseSharedFlags(argv, cwd);
  const command = positional[0] || "open";
  if (!["init", "open", "status", "stop"].includes(command)) {
    throw new Error(`Unsupported isolated-instance command: ${command}`);
  }
  return { ...options, command };
}

function writeJsonFile(filePath, value) {
  return fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureSymlink(targetPath, linkPath, { force = false } = {}) {
  let existingStat = null;
  try {
    existingStat = await fsp.lstat(linkPath);
    if (existingStat.isSymbolicLink()) {
      const existingTarget = await fsp.readlink(linkPath);
      const resolvedExisting = path.resolve(path.dirname(linkPath), existingTarget);
      if (resolvedExisting === targetPath) {
        return;
      }
      if (!force) {
        throw new Error(
          `Refusing to repoint existing symlink at ${linkPath}. Pass --force to replace it.`,
        );
      }
      await fsp.rm(linkPath, { recursive: true, force: true });
      await fsp.symlink(targetPath, linkPath, "dir");
      return;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  if (existingStat) {
    if (!force) {
      throw new Error(
        `Refusing to replace existing non-symlink path at ${linkPath}. Pass --force to replace it.`,
      );
    }
    await fsp.rm(linkPath, { recursive: true, force: true });
  }

  await fsp.symlink(targetPath, linkPath, "dir");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readManagedVaultMarker(vaultDir) {
  const markerPath = path.join(vaultDir, ISOLATED_VAULT_MARKER);
  try {
    return JSON.parse(await fsp.readFile(markerPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertSafeVaultTarget(vaultDir) {
  const resolvedVaultDir = path.resolve(vaultDir);
  const cwd = process.cwd();
  const homeDir = os.homedir();
  const rootDir = path.parse(resolvedVaultDir).root;

  if (
    resolvedVaultDir === rootDir ||
    isSubpath(resolvedVaultDir, cwd) ||
    isSubpath(resolvedVaultDir, homeDir)
  ) {
    throw new Error(`Refusing to manage unsafe vault directory: ${resolvedVaultDir}`);
  }
}

async function prepareVaultDirectory({
  vaultDir,
  clean = false,
  force = false,
  managedVaultDir,
}) {
  assertSafeVaultTarget(vaultDir);

  const resolvedVaultDir = path.resolve(vaultDir);
  const resolvedManagedVaultDir = managedVaultDir ? path.resolve(managedVaultDir) : null;
  const vaultExists = await pathExists(resolvedVaultDir);
  const marker = vaultExists ? await readManagedVaultMarker(resolvedVaultDir) : null;
  const isDefaultManagedVault = resolvedManagedVaultDir === resolvedVaultDir;

  if (vaultExists && !marker && !isDefaultManagedVault && !force) {
    throw new Error(
      `Refusing to modify existing unmarked vault at ${resolvedVaultDir}. Pass --force to adopt it intentionally.`,
    );
  }

  if (!clean || !vaultExists) {
    return;
  }

  if (!marker && !isDefaultManagedVault && !force) {
    throw new Error(
      `Refusing to delete existing vault at ${resolvedVaultDir}. Clean only removes marked isolated vaults by default unless --force is provided.`,
    );
  }

  await fsp.rm(resolvedVaultDir, { recursive: true, force: true });
}

async function inspectIsolatedVault({ vaultDir }) {
  const resolvedVaultDir = path.resolve(vaultDir);
  const obsidianDir = path.join(resolvedVaultDir, ".obsidian");
  const pluginLinkPath = path.join(obsidianDir, "plugins", WORK_TERMINAL_PLUGIN_ID);
  const marker = await readManagedVaultMarker(resolvedVaultDir);

  let pluginLinkType = "missing";
  let pluginTarget = null;
  try {
    const stat = await fsp.lstat(pluginLinkPath);
    if (stat.isSymbolicLink()) {
      pluginLinkType = "symlink";
      pluginTarget = path.resolve(path.dirname(pluginLinkPath), await fsp.readlink(pluginLinkPath));
    } else if (stat.isDirectory()) {
      pluginLinkType = "directory";
    } else {
      pluginLinkType = "file";
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  return {
    vaultDir: resolvedVaultDir,
    exists: await pathExists(resolvedVaultDir),
    markerPath: path.join(resolvedVaultDir, ISOLATED_VAULT_MARKER),
    managed: Boolean(marker),
    pluginLinkPath,
    pluginLinkType,
    pluginTarget,
    obsidianDirExists: await pathExists(obsidianDir),
  };
}

function buildSampleTaskContent(title, state) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `---
id: ${crypto.randomUUID()}
tags:
  - task
  - task/${state}

state: ${state}

title: "${title}"

source:
  type: prompt
  id: "seed-${state}"
  url: ""
  captured: ${now}

priority:
  score: ${state === "priority" ? 90 : state === "active" ? 40 : 10}
  deadline: ""
  impact: medium
  has-blocker: false
  blocker-context: ""

agent-actionable: false

goal:
  - review-${state}

related: []

created: ${now}
updated: ${now}
---
# ${title}

## Notes

Seed task for isolated UI automation and screenshot checks.
`;
}

async function seedTaskFiles(vaultDir) {
  const baseDir = path.join(vaultDir, "2 - Areas", "Tasks");
  const taskFiles = [
    {
      directory: path.join(baseDir, "active"),
      filename: "TASK-automation-smoke.md",
      title: "Automation smoke test",
      state: "active",
    },
    {
      directory: path.join(baseDir, "todo"),
      filename: "TASK-screenshot-regression.md",
      title: "Screenshot regression capture",
      state: "todo",
    },
  ];

  for (const task of taskFiles) {
    const filePath = path.join(task.directory, task.filename);
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch {
      await fsp.writeFile(filePath, buildSampleTaskContent(task.title, task.state), "utf8");
    }
  }
}

async function ensureIsolatedVault({
  vaultDir,
  pluginDir,
  clean = false,
  sampleData = true,
  force = false,
  managedVaultDir,
}) {
  const resolvedVaultDir = path.resolve(vaultDir);
  const resolvedPluginDir = path.resolve(pluginDir);
  const obsidianDir = path.join(resolvedVaultDir, ".obsidian");
  const pluginParentDir = path.join(obsidianDir, "plugins");
  const pluginLinkPath = path.join(pluginParentDir, WORK_TERMINAL_PLUGIN_ID);
  const taskBaseDir = path.join(resolvedVaultDir, "2 - Areas", "Tasks");

  await prepareVaultDirectory({
    vaultDir: resolvedVaultDir,
    clean,
    force,
    managedVaultDir,
  });

  await fsp.mkdir(pluginParentDir, { recursive: true });
  await fsp.mkdir(path.join(taskBaseDir, "priority"), { recursive: true });
  await fsp.mkdir(path.join(taskBaseDir, "active"), { recursive: true });
  await fsp.mkdir(path.join(taskBaseDir, "todo"), { recursive: true });
  await fsp.mkdir(path.join(taskBaseDir, "archive"), { recursive: true });

  await ensureSymlink(resolvedPluginDir, pluginLinkPath, { force });
  await writeJsonFile(path.join(obsidianDir, "community-plugins.json"), [WORK_TERMINAL_PLUGIN_ID]);
  await writeJsonFile(path.join(obsidianDir, "core-plugins.json"), []);
  await writeJsonFile(path.join(obsidianDir, "app.json"), {
    communityPlugins: true,
    legacyEditor: false,
  });
  await writeJsonFile(path.join(resolvedVaultDir, ISOLATED_VAULT_MARKER), {
    pluginId: WORK_TERMINAL_PLUGIN_ID,
    pluginDir: resolvedPluginDir,
  });

  if (sampleData) {
    await seedTaskFiles(resolvedVaultDir);
  }

  return {
    vaultDir: resolvedVaultDir,
    pluginDir: resolvedPluginDir,
    pluginLinkPath,
  };
}

function fetchTargets({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://${host}:${port}/json`, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out fetching CDP targets from ${host}:${port}`));
    });
    request.on("error", reject);
  });
}

function findObsidianPageTarget(targets) {
  if (!Array.isArray(targets)) {
    return null;
  }

  return targets.find(
    (candidate) =>
      candidate?.type === "page" &&
      candidate.webSocketDebuggerUrl &&
      (!candidate.title || candidate.title.includes("Obsidian")),
  );
}

function waitForDebugger({ host = DEFAULT_HOST, port = getDefaultPort(), timeoutMs = 20_000 }) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const targets = await fetchTargets({ host, port, timeoutMs: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) });
        if (findObsidianPageTarget(targets)) {
          resolve(targets);
          return;
        }
      } catch {
        // Keep polling until timeout.
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for Obsidian debugger on ${host}:${port}`));
        return;
      }

      setTimeout(attempt, 500);
    };

    void attempt();
  });
}

async function assertDebuggerPortAvailable({ host = DEFAULT_HOST, port = getDefaultPort(), timeoutMs = DEFAULT_TIMEOUT_MS }) {
  try {
    await fetchTargets({ host, port, timeoutMs });
  } catch (error) {
    if (error && ["ECONNREFUSED", "EHOSTUNREACH"].includes(error.code)) {
      return;
    }
    if (error && error.code === "ECONNRESET") {
      throw new Error(`Debugger port ${host}:${port} is already in use by a non-CDP service`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Debugger port ${host}:${port} is already in use by a non-CDP service`);
    }
    if (error && /socket hang up/i.test(error.message || "")) {
      throw new Error(`Debugger port ${host}:${port} is already in use by a non-CDP service`);
    }
    if (error && /ECONNREFUSED/i.test(error.message || "")) {
      return;
    }
    throw new Error(`Debugger port ${host}:${port} is already in use`);
  }

  throw new Error(`Debugger port ${host}:${port} is already in use. Choose a different --port.`);
}

function parseObsidianProcessList(psOutput) {
  return String(psOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      const [, pidText, command] = match;
      const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
      return {
        pid: Number.parseInt(pidText, 10),
        command,
        port: portMatch ? Number.parseInt(portMatch[1], 10) : null,
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.pid));
}

function listRunningObsidianProcesses() {
  const psOutput = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  return parseObsidianProcessList(
    psOutput
      .split(/\r?\n/)
      .filter((line) => /(?:^|\s)(?:.+\/)?Obsidian\.app\/Contents\/MacOS\/Obsidian\b/.test(line))
      .join("\n"),
  );
}

/**
 * Check whether an isolated Obsidian launch is safe. With direct binary launch
 * and --user-data-dir, multiple instances can coexist, so this only warns about
 * port conflicts rather than blocking on any running Obsidian process.
 */
function assertIsolatedLaunchSupported({ port = getDefaultPort(), runningProcesses = listRunningObsidianProcesses() } = {}) {
  if (!runningProcesses || runningProcesses.length === 0) {
    return;
  }

  const portConflict = runningProcesses.find((p) => p.port === port);
  if (portConflict) {
    throw new Error(
      `Another Obsidian process (PID ${portConflict.pid}) is already using debug port ${port}. Choose a different --port or use automatic port selection.`,
    );
  }
}

function encodeClientFrame(payloadBuffer, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payloadBuffer.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payloadBuffer.length;
    mask.copy(header, 2);
  } else if (payloadBuffer.length < 65_536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadBuffer.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
    mask.copy(header, 10);
  }

  const maskedPayload = Buffer.alloc(payloadBuffer.length);
  for (let i = 0; i < payloadBuffer.length; i += 1) {
    maskedPayload[i] = payloadBuffer[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, maskedPayload]);
}

function readNextFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) {
    return null;
  }

  let payload = buffer.slice(offset + maskLength, offset + maskLength + payloadLength);
  if (masked) {
    const maskingKey = buffer.slice(offset, offset + 4);
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      unmasked[i] = payload[i] ^ maskingKey[i % 4];
    }
    payload = unmasked;
  }

  return {
    opcode,
    payload,
    rest: buffer.slice(offset + maskLength + payloadLength),
  };
}

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;

    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushFrames();
    });

    this.socket.on("error", (error) => {
      this.rejectAll(error);
    });

    this.socket.on("close", () => {
      this.rejectAll(new Error("CDP connection closed"));
    });
  }

  static async connect({ host = DEFAULT_HOST, port = getDefaultPort(), timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const targets = await fetchTargets({ host, port, timeoutMs });
    const target = findObsidianPageTarget(targets);

    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(`No Obsidian page target found on ${host}:${port}`);
    }

    const wsUrl = new URL(target.webSocketDebuggerUrl);
    const key = crypto.randomBytes(16).toString("base64");

    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: wsUrl.hostname,
        port: wsUrl.port,
        path: wsUrl.pathname,
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });

      request.on("upgrade", (_response, socket) => {
        resolve(new CDPClient(socket));
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Timed out opening CDP websocket on ${host}:${port}`));
      });
      request.on("error", reject);
      request.end();
    });
  }

  flushFrames() {
    while (true) {
      const frame = readNextFrame(this.buffer);
      if (!frame) return;
      this.buffer = frame.rest;

      if (frame.opcode === 0x8) {
        this.socket.end();
        return;
      }

      if (frame.opcode === 0x9) {
        this.socket.write(encodeClientFrame(frame.payload, 0x0a));
        continue;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        continue;
      }

      if (typeof message.id !== "number") {
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP command failed"));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    this.socket.write(encodeClientFrame(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime evaluation failed";
      throw new Error(description);
    }

    return result.result?.value;
  }

  close() {
    this.socket.end();
  }
}

function commandExpression(commandId) {
  return `
    (() => {
      const commandId = ${JSON.stringify(commandId)};
      const executeCommandById = globalThis.app?.commands?.executeCommandById;
      if (typeof executeCommandById !== "function") {
        throw new Error("Obsidian command API is unavailable");
      }
      return executeCommandById.call(globalThis.app.commands, commandId);
    })()
  `;
}

function elementRectExpression(selector) {
  return `
    (async () => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error("Selector not found: " + selector);
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
      };
    })()
  `;
}

function waitForSelectorExpression(selector, timeoutMs) {
  return `
    (async () => {
      const selector = ${JSON.stringify(selector)};
      const timeoutMs = ${timeoutMs};
      const existing = document.querySelector(selector);
      if (existing) {
        existing.scrollIntoView({ block: "center", inline: "center" });
        return true;
      }
      await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const match = document.querySelector(selector);
          if (!match) return;
          clearTimeout(timer);
          observer.disconnect();
          match.scrollIntoView({ block: "center", inline: "center" });
          resolve(true);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Timed out waiting for selector: " + selector));
        }, timeoutMs);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      });
      return true;
    })()
  `;
}

function waitForWorkspaceLeafExpression(viewType, timeoutMs) {
  return `
    (async () => {
      const viewType = ${JSON.stringify(viewType)};
      const timeoutMs = ${timeoutMs};
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const leaves = globalThis.app?.workspace?.getLeavesOfType?.(viewType) ?? [];
        if (leaves.length > 0) {
          return leaves.length;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Timed out waiting for workspace leaf: " + viewType);
    })()
  `;
}

function focusAndClearExpression(selector) {
  return `
    (async () => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error("Selector not found: " + selector);
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();
      if ("value" in element) {
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = "";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
      }
      return true;
    })()
  `;
}

async function clickSelector(client, selector) {
  const rect = await client.evaluate(elementRectExpression(selector));
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y,
    button: "none",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  return rect;
}

async function typeIntoSelector(client, selector, text) {
  await client.evaluate(focusAndClearExpression(selector));
  await client.send("Input.insertText", { text });
  return { selector, textLength: text.length };
}

async function captureScreenshot(client, { outputPath, selector, selectorPadding = DEFAULT_SELECTOR_PADDING, fullPage = false }) {
  await client.send("Page.enable");
  const captureParams = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  };

  if (selector && !fullPage) {
    const rect = await client.evaluate(elementRectExpression(selector));
    captureParams.clip = {
      x: Math.max(0, rect.left - selectorPadding),
      y: Math.max(0, rect.top - selectorPadding),
      width: Math.max(1, rect.width + selectorPadding * 2),
      height: Math.max(1, rect.height + selectorPadding * 2),
      scale: 1,
    };
  }

  const result = await client.send("Page.captureScreenshot", captureParams);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}

async function runCdpCommand(config) {
  const client = await CDPClient.connect({
    host: config.host,
    port: config.port,
    timeoutMs: config.timeoutMs,
  });
  try {
    switch (config.command) {
      case "reload":
        await client.evaluate(commandExpression(WORK_TERMINAL_COMMAND_IDS.reload));
        return "Reload triggered";
      case "open-view":
        await client.evaluate(commandExpression(WORK_TERMINAL_COMMAND_IDS.openView));
        await client.evaluate(waitForWorkspaceLeafExpression("work-terminal-view", config.timeoutMs));
        return "Work Terminal view opened";
      case "eval": {
        const result = await client.evaluate(config.expression);
        return result;
      }
      case "wait-for":
        await client.evaluate(waitForSelectorExpression(config.selector, config.timeoutMs));
        return `Selector ready: ${config.selector}`;
      case "click": {
        const rect = await clickSelector(client, config.selector);
        return { selector: config.selector, rect };
      }
      case "type":
        return typeIntoSelector(client, config.selector, config.text);
      case "screenshot": {
        const outputPath = await captureScreenshot(client, config);
        return { outputPath };
      }
      default:
        throw new Error(`Unsupported CDP command: ${config.command}`);
    }
  } finally {
    client.close();
  }
}

async function verifyObsidianVault({ host = DEFAULT_HOST, port = getDefaultPort(), timeoutMs = DEFAULT_TIMEOUT_MS, expectedVaultDir }) {
  const resolvedExpected = path.resolve(expectedVaultDir);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    const remainingTimeoutMs = Math.max(250, Math.min(DEFAULT_TIMEOUT_MS, deadline - Date.now()));
    let client = null;
    try {
      client = await CDPClient.connect({ host, port, timeoutMs: remainingTimeoutMs });
      const actualVaultDir = await client.evaluate("globalThis.app?.vault?.adapter?.basePath ?? null");
      const resolvedActual = actualVaultDir ? path.resolve(actualVaultDir) : null;
      if (!resolvedActual) {
        lastError = new Error(`Obsidian renderer on ${host}:${port} has not attached a vault yet`);
      } else if (resolvedActual !== resolvedExpected) {
        throw new Error(
          `Connected debugger is attached to ${resolvedActual}, expected ${resolvedExpected}`,
        );
      } else {
        return resolvedActual;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /No Obsidian page target found/i.test(error.message)
      ) {
        lastError = error;
      } else {
        throw error;
      }
    } finally {
      client?.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for Obsidian to load vault ${resolvedExpected} on ${host}:${port}${
      lastError ? ` (${lastError.message})` : ""
    }`,
  );
}

/**
 * Dismiss the "Do you trust the author of this vault?" dialog that appears on
 * first launch of a vault with community plugins. Clicks the "Trust author and
 * enable plugins" button if present, then waits briefly for plugins to load.
 * No-op if the dialog is not showing.
 */
async function dismissTrustDialog({ host = DEFAULT_HOST, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const startedAt = Date.now();
  // Poll for the trust dialog - it may not be in the DOM immediately after vault load
  while (Date.now() - startedAt < timeoutMs) {
    const client = await CDPClient.connect({ host, port, timeoutMs: Math.max(2000, timeoutMs - (Date.now() - startedAt)) });
    try {
      const clicked = await client.evaluate(`(() => {
        const buttons = document.querySelectorAll(".modal-button-container button");
        for (const btn of buttons) {
          if (btn.textContent.includes("Trust author")) {
            btn.click();
            return true;
          }
        }
        return false;
      })()`);
      if (clicked) {
        // Wait for plugins to load after trusting
        await new Promise((r) => setTimeout(r, 2000));
        return true;
      }
      // Check if plugins are already loaded (no dialog needed)
      const pluginsLoaded = await client.evaluate(
        "Object.keys(globalThis.app?.plugins?.plugins || {}).length > 0",
      );
      if (pluginsLoaded) {
        return false;
      }
    } finally {
      client.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Pre-seed the Obsidian user-data-dir so the isolated instance opens the vault
 * directly instead of showing the starter/vault-picker screen. Creates an
 * obsidian.json with the vault registered and marked as open.
 */
async function seedUserDataDir({ userDataDir, vaultDir }) {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const resolvedVaultDir = path.resolve(vaultDir);
  await fsp.mkdir(resolvedUserDataDir, { recursive: true });

  // Obsidian uses a hex hash as the vault ID. We generate a stable one from
  // the vault path so repeated runs reuse the same config entry.
  const vaultId = crypto.createHash("sha256").update(resolvedVaultDir).digest("hex").slice(0, 16);

  await writeJsonFile(path.join(resolvedUserDataDir, "obsidian.json"), {
    vaults: {
      [vaultId]: {
        path: resolvedVaultDir,
        ts: Date.now(),
        open: true,
      },
    },
  });
}

/**
 * WARNING: Launching an isolated Obsidian instance briefly steals user focus
 * (~2-3 seconds) before the window can be hidden via CDP. This MUST NOT be
 * triggered automatically - only with explicit user consent for testing or
 * bug replication.
 *
 * For automated testing, prefer filesystem-based task manipulation combined
 * with CDP UI interaction over agent sessions. Agent sessions require VERY
 * EXPLICIT user approval.
 *
 * Uses direct binary launch with --user-data-dir to bypass macOS singleton
 * routing. The spawned process is detached so it outlives the launcher script.
 */
function launchObsidian({ vaultDir, port = getDefaultPort(), userDataDir }) {
  const args = [`--remote-debugging-port=${port}`];
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  args.push(vaultDir);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(OBSIDIAN_BINARY, args, {
        stdio: "ignore",
        detached: true,
      });
    } catch (error) {
      reject(new Error(`Failed to spawn Obsidian: ${error.message}`));
      return;
    }
    child.unref();
    child.on("error", (error) => reject(new Error(`Failed to spawn Obsidian: ${error.message}`)));
    // Detached process exits the parent almost immediately; give the OS a moment
    // to confirm the binary launched before resolving.
    setTimeout(() => resolve({ pid: child.pid }), 300);
  });
}

/**
 * Find an available debug port in the isolated range (ISOLATED_PORT_BASE to
 * ISOLATED_PORT_BASE + ISOLATED_PORT_RANGE - 1). Tries random ports, checking
 * both TCP availability and conflict with running Obsidian processes.
 */
async function findAvailablePort({ host = DEFAULT_HOST, maxAttempts = 10 } = {}) {
  const runningProcesses = listRunningObsidianProcesses();
  const usedPorts = new Set(runningProcesses.filter((p) => p.port).map((p) => p.port));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = ISOLATED_PORT_BASE + Math.floor(Math.random() * ISOLATED_PORT_RANGE);
    if (usedPorts.has(port)) {
      continue;
    }
    try {
      await assertDebuggerPortAvailable({ host, port, timeoutMs: 2_000 });
      return port;
    } catch {
      // Port occupied, try another
    }
  }
  throw new Error(
    `Could not find an available port in range ${ISOLATED_PORT_BASE}-${ISOLATED_PORT_BASE + ISOLATED_PORT_RANGE - 1} after ${maxAttempts} attempts`,
  );
}

/**
 * Hide the Obsidian window via CDP. Must be called after Obsidian has finished
 * its startup sequence (otherwise it will re-show the window).
 */
async function hideObsidianWindow({ host = DEFAULT_HOST, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const client = await CDPClient.connect({ host, port, timeoutMs });
  try {
    await client.evaluate("window.electron.remote.getCurrentWindow().hide()");
  } finally {
    client.close();
  }
}

/**
 * Kill an isolated Obsidian instance identified by its --user-data-dir path.
 * Returns the number of processes killed.
 */
function killIsolatedInstance({ userDataDir, runningProcesses = listRunningObsidianProcesses() }) {
  if (!userDataDir) {
    throw new Error("userDataDir is required to identify the isolated instance");
  }
  const resolvedDir = path.resolve(userDataDir);
  const matches = runningProcesses.filter((p) => p.command.includes(`--user-data-dir=${resolvedDir}`));
  for (const proc of matches) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
  return matches.length;
}

module.exports = {
  CDPClient,
  DEFAULT_DEBUG_PORT,
  DEFAULT_HOST,
  DEFAULT_SCREENSHOT_PATH,
  DEFAULT_SELECTOR_PADDING,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VAULT_DIR,
  ISOLATED_PORT_BASE,
  ISOLATED_PORT_RANGE,
  OBSIDIAN_BINARY,
  WORK_TERMINAL_COMMAND_IDS,
  captureScreenshot,
  commandExpression,
  assertDebuggerPortAvailable,
  assertIsolatedLaunchSupported,
  dismissTrustDialog,
  ensureIsolatedVault,
  ensureSymlink,
  findAvailablePort,
  findObsidianPageTarget,
  getDefaultPort,
  hideObsidianWindow,
  inspectIsolatedVault,
  killIsolatedInstance,
  launchObsidian,
  listRunningObsidianProcesses,
  parseCdpArgs,
  parseIsolatedInstanceArgs,
  parseObsidianProcessList,
  prepareVaultDirectory,
  readManagedVaultMarker,
  runCdpCommand,
  seedUserDataDir,
  verifyObsidianVault,
  waitForDebugger,
};
