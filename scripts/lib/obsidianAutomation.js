const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_DEBUG_PORT = 9222;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 10_000;
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
  if (!["init", "open", "status"].includes(command)) {
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

function waitForDebugger({ host = DEFAULT_HOST, port = getDefaultPort(), timeoutMs = 20_000 }) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const targets = await fetchTargets({ host, port, timeoutMs: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS) });
        if (Array.isArray(targets) && targets.length > 0) {
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
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
        (!candidate.title || candidate.title.includes("Obsidian")),
    );

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
  return `app.commands.executeCommandById(${JSON.stringify(commandId)})`;
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
  const client = await CDPClient.connect({ host, port, timeoutMs });
  try {
    const actualVaultDir = await client.evaluate("app?.vault?.adapter?.basePath ?? null");
    const resolvedActual = actualVaultDir ? path.resolve(actualVaultDir) : null;
    const resolvedExpected = path.resolve(expectedVaultDir);
    if (resolvedActual !== resolvedExpected) {
      throw new Error(
        `Connected debugger is attached to ${resolvedActual || "an unknown vault"}, expected ${resolvedExpected}`,
      );
    }
    return resolvedActual;
  } finally {
    client.close();
  }
}

function launchObsidian({ vaultDir, port = getDefaultPort() }) {
  return new Promise((resolve, reject) => {
    const child = spawn("open", ["-na", "Obsidian", "--args", `--remote-debugging-port=${port}`, vaultDir], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`open exited with code ${code}`));
      }
    });
  });
}

module.exports = {
  CDPClient,
  DEFAULT_DEBUG_PORT,
  DEFAULT_HOST,
  DEFAULT_SCREENSHOT_PATH,
  DEFAULT_SELECTOR_PADDING,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VAULT_DIR,
  WORK_TERMINAL_COMMAND_IDS,
  captureScreenshot,
  commandExpression,
  assertDebuggerPortAvailable,
  ensureIsolatedVault,
  ensureSymlink,
  getDefaultPort,
  inspectIsolatedVault,
  launchObsidian,
  parseCdpArgs,
  parseIsolatedInstanceArgs,
  prepareVaultDirectory,
  readManagedVaultMarker,
  runCdpCommand,
  verifyObsidianVault,
  waitForDebugger,
};
