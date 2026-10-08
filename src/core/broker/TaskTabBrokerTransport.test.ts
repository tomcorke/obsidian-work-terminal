import { mkdtempSync, rmSync, statSync } from "fs";
import { connect } from "net";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalTabHostSnapshot, TerminalTabTarget } from "../terminal/TerminalHost";
import { BROKER_FRAME_MAX_BYTES, TaskTabBroker } from "./TaskTabBroker";
import { TaskTabBrokerTransport } from "./TaskTabBrokerTransport";

const caller: TerminalTabTarget = { taskId: "task-a", tabId: "tab-a", generation: 1 };
const callerTab: TerminalTabHostSnapshot = {
  ...caller,
  label: "Claude",
  sessionType: "claude",
  profileId: "profile-a",
  state: "active",
  processStatus: "running",
  latestSequence: "1",
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function makeBroker() {
  const broker = new TaskTabBroker({
    vaultId: "vault-a",
    catalogue: {
      listCategories: async () => [{ id: "active", label: "Active" }],
      listTasks: async () => ({ tasks: [], truncated: false }),
      getTask: async () => null,
      getSubtasks: async () => null,
      getParentTasks: async () => null,
    },
    getProfileCapabilities: () => ["discover"],
  });
  broker.registerHost("vault-a", {
    getTabHostSnapshots: (taskId) => (taskId === "task-a" ? [callerTab] : []),
    getAllTabHostSnapshots: () => [callerTab],
    readTabOutput: () => null,
  });
  const token = broker.issueToken({
    vaultId: "vault-a",
    caller,
    profileId: "profile-a",
    capabilities: ["discover"],
  });
  return { broker, token };
}

function readFrame(socket: ReturnType<typeof connect>): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Connection closed before a frame arrived"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function exchange(
  endpoint: string,
  frames: Array<Record<string, unknown> | Buffer>,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const responses: any[] = [];
    let text = "";
    socket.on("connect", () => {
      for (const frame of frames) {
        socket.write(Buffer.isBuffer(frame) ? frame : `${JSON.stringify(frame)}\n`);
      }
    });
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const lines = text.split("\n");
      text = lines.pop()!;
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
      if (responses.length >= frames.length) socket.end();
    });
    socket.on("end", () => resolve(responses));
    socket.on("error", reject);
  });
}

describe("TaskTabBrokerTransport", () => {
  it("serves bounded versioned frames and binds requests to hello context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wt-broker-test-"));
    const endpoint = join(directory, "broker.sock");
    const { broker, token } = makeBroker();
    const transport = new TaskTabBrokerTransport(broker, endpoint);
    cleanup.push(async () => {
      await transport.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await transport.start();

    const responses = await exchange(endpoint, [
      { v: 1, type: "hello", id: "h1", token },
      { v: 1, type: "request", id: "r1", method: "listCategories", params: {} },
    ]);

    expect(responses).toMatchObject([
      {
        ok: true,
        result: { caller, capabilities: ["discover"], brokerEpoch: expect.any(String) },
      },
      { ok: true, result: [{ id: "active", label: "Active" }] },
    ]);
    if (process.platform !== "win32") expect(statSync(endpoint).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid authentication and oversized frames before dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wt-broker-test-"));
    const endpoint = join(directory, "broker.sock");
    const { broker } = makeBroker();
    const transport = new TaskTabBrokerTransport(broker, endpoint);
    cleanup.push(async () => {
      await transport.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await transport.start();

    await expect(
      exchange(endpoint, [{ v: 1, type: "hello", id: "h1", token: "wrong" }]),
    ).resolves.toMatchObject([{ ok: false, error: { code: "AUTH_FAILED" } }]);
    const oversized = Buffer.from(`${"x".repeat(BROKER_FRAME_MAX_BYTES + 1)}\n`);
    await expect(exchange(endpoint, [oversized])).resolves.toMatchObject([
      { ok: false, error: { code: "LIMIT_EXCEEDED" } },
    ]);
  });

  it("keeps mailbox delivery available when the recipient reconnects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wt-broker-test-"));
    const endpoint = join(directory, "broker.sock");
    const recipient: TerminalTabTarget = { taskId: "task-b", tabId: "tab-b", generation: 1 };
    const recipientTab: TerminalTabHostSnapshot = {
      ...callerTab,
      ...recipient,
      profileId: "profile-b",
    };
    const broker = new TaskTabBroker({
      vaultId: "vault-a",
      catalogue: {
        listCategories: async () => [],
        listTasks: async () => ({ tasks: [], truncated: false }),
        getTask: async () => null,
        getSubtasks: async () => null,
        getParentTasks: async () => null,
      },
      getProfileCapabilities: () => ["message"],
    });
    broker.registerHost("vault-a", {
      getTabHostSnapshots: (taskId) =>
        [callerTab, recipientTab].filter((tab) => tab.taskId === taskId),
      getAllTabHostSnapshots: () => [callerTab, recipientTab],
      readTabOutput: () => {
        throw new Error("mailbox delivery must not read terminal output");
      },
    });
    const senderToken = broker.issueToken({
      vaultId: "vault-a",
      caller,
      profileId: "profile-a",
      capabilities: ["message"],
    });
    const recipientToken = broker.issueToken({
      vaultId: "vault-a",
      caller: recipient,
      profileId: "profile-b",
      capabilities: ["message"],
    });
    const transport = new TaskTabBrokerTransport(broker, endpoint);
    cleanup.push(async () => {
      await transport.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await transport.start();

    await expect(
      exchange(endpoint, [
        { v: 1, type: "hello", id: "recipient-disconnects", token: recipientToken },
      ]),
    ).resolves.toMatchObject([{ ok: true }]);
    await expect(
      exchange(endpoint, [
        { v: 1, type: "hello", id: "sender", token: senderToken },
        {
          v: 1,
          type: "request",
          id: "send",
          method: "sendMessage",
          params: {
            target: recipient,
            clientMessageId: "after-disconnect",
            payload: { ready: true },
          },
        },
      ]),
    ).resolves.toMatchObject([{ ok: true }, { ok: true }]);
    const recipientSocket = connect(endpoint);
    await new Promise<void>((resolve, reject) => {
      recipientSocket.once("connect", resolve);
      recipientSocket.once("error", reject);
    });
    recipientSocket.write(
      `${JSON.stringify({ v: 1, type: "hello", id: "recipient-listens", token: recipientToken })}\n`,
    );
    await expect(readFrame(recipientSocket)).resolves.toMatchObject({ ok: true });
    const availableEvent = readFrame(recipientSocket);
    await expect(
      exchange(endpoint, [
        { v: 1, type: "hello", id: "sender-again", token: senderToken },
        {
          v: 1,
          type: "request",
          id: "send-again",
          method: "sendMessage",
          params: {
            target: recipient,
            clientMessageId: "while-connected",
            payload: { ready: "again" },
          },
        },
      ]),
    ).resolves.toMatchObject([{ ok: true }, { ok: true }]);
    await expect(availableEvent).resolves.toMatchObject({
      type: "event",
      event: "mailbox.available",
      sequence: "1",
      data: { pending: 2 },
    });
    recipientSocket.destroy();

    await expect(
      exchange(endpoint, [
        { v: 1, type: "hello", id: "recipient-reconnects", token: recipientToken },
        { v: 1, type: "request", id: "receive", method: "receiveMessages", params: {} },
      ]),
    ).resolves.toMatchObject([
      { ok: true },
      {
        ok: true,
        result: {
          messages: [
            { clientMessageId: "after-disconnect", payload: { ready: true } },
            { clientMessageId: "while-connected", payload: { ready: "again" } },
          ],
        },
      },
    ]);
  });

  it("rebinds the same private endpoint so live callers can reconnect after reload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wt-broker-test-"));
    const endpoint = join(directory, "broker.sock");
    const { broker, token } = makeBroker();
    const firstEpoch = (broker.hello(token, "before") as any).result.brokerEpoch;
    const first = new TaskTabBrokerTransport(broker, endpoint);
    await first.start();
    const reloadSocket = connect(endpoint);
    await new Promise<void>((resolve, reject) => {
      reloadSocket.once("connect", resolve);
      reloadSocket.once("error", reject);
    });
    reloadSocket.write(`${JSON.stringify({ v: 1, type: "hello", id: "reload", token })}\n`);
    await expect(readFrame(reloadSocket)).resolves.toMatchObject({ ok: true });
    const reloadEvent = readFrame(reloadSocket);
    await first.stop({ reloading: true });
    await expect(reloadEvent).resolves.toMatchObject({
      type: "event",
      event: "broker.reloading",
    });

    const replacementBroker = new TaskTabBroker({
      vaultId: "vault-a",
      catalogue: {
        listCategories: async () => [],
        listTasks: async () => ({ tasks: [], truncated: false }),
        getTask: async () => null,
        getSubtasks: async () => null,
        getParentTasks: async () => null,
      },
      getProfileCapabilities: () => ["discover"],
      runtimeState: broker.exportRuntimeState(),
    });
    replacementBroker.registerHost("vault-a", {
      getTabHostSnapshots: (taskId) => (taskId === "task-a" ? [callerTab] : []),
      getAllTabHostSnapshots: () => [callerTab],
      readTabOutput: () => null,
    });
    const replacement = new TaskTabBrokerTransport(replacementBroker, endpoint);
    cleanup.push(async () => {
      await replacement.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await replacement.start();

    const responses = await exchange(endpoint, [{ v: 1, type: "hello", id: "again", token }]);
    expect(responses).toMatchObject([{ ok: true, result: { caller } }]);
    expect(responses[0].result.brokerEpoch).not.toBe(firstEpoch);
  });
});
