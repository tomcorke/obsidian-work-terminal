import { describe, expect, it, vi } from "vitest";
import type {
  CleanOutputRead,
  TerminalTabHostSnapshot,
  TerminalTabTarget,
} from "../terminal/TerminalHost";
import { TaskTabBroker, type BrokerCapability, type BrokerTerminalHost } from "./TaskTabBroker";

const caller: TerminalTabTarget = { taskId: "task-a", tabId: "tab-a", generation: 1 };
const callerTab: TerminalTabHostSnapshot = {
  ...caller,
  label: "Claude",
  sessionType: "claude",
  profileId: "profile-a",
  state: "active",
  processStatus: "running",
  latestSequence: "2",
};

function request(method: string, params: Record<string, unknown> = {}, id = "r1") {
  return { v: 1, type: "request" as const, id, method, params };
}

function setup(capabilities: BrokerCapability[] = ["discover", "read"], now?: () => number) {
  const tabs = new Map<string, TerminalTabHostSnapshot[]>([["task-a", [callerTab]]]);
  const outputs = new Map<string, CleanOutputRead>();
  const focusState = { taskId: "task-a", tabId: "tab-a" };
  const focusEffects = { activate: vi.fn(), selectTask: vi.fn(), focusTab: vi.fn() };
  const host: BrokerTerminalHost & typeof focusEffects = {
    getTabHostSnapshots: (taskId) => tabs.get(taskId) ?? [],
    getAllTabHostSnapshots: () => [...tabs.values()].flat(),
    readTabOutput: (target) => outputs.get(`${target.tabId}:${target.generation}`) ?? null,
    ...focusEffects,
  };
  const tasks = [
    {
      id: "task-a",
      title: "Task A",
      state: "active",
      categoryId: "active",
      reference: "Tasks/a.md",
      directParentIds: [],
      directChildIds: ["task-b"],
    },
    {
      id: "task-b",
      title: "Task B",
      state: "backlog",
      categoryId: "backlog",
      reference: "Tasks/b.md",
      directParentIds: ["task-a"],
      directChildIds: [],
    },
  ];
  const traversal = {
    tasks: [{ ...tasks[1], depth: 1, direct: true }],
    missingIds: ["missing"],
    cycles: [],
    truncated: false,
    truncation: { depthLimitReached: false, resultLimitReached: false },
  };
  const catalogue = {
    listCategories: async () => [{ id: "active", label: "Active" }],
    listTasks: async ({ categoryId, limit }: { categoryId?: string; limit?: number }) => ({
      tasks: tasks
        .filter((task) => categoryId === undefined || task.categoryId === categoryId)
        .slice(0, limit),
      truncated: false,
    }),
    getTask: async (taskId: string) => tasks.find(({ id }) => id === taskId) ?? null,
    getSubtasks: async (taskId: string) => (taskId === "task-a" ? traversal : null),
    getParentTasks: async (taskId: string) =>
      taskId === "task-b"
        ? { ...traversal, tasks: [{ ...tasks[0], depth: 1, direct: true }], missingIds: [] }
        : null,
  };
  const grants = new Map<string, BrokerCapability[]>([["profile-a", capabilities]]);
  const broker = new TaskTabBroker({
    vaultId: "vault-a",
    catalogue,
    getProfileCapabilities: (profileId) => grants.get(profileId) ?? [],
    ...(now ? { now } : {}),
  });
  broker.registerHost("vault-a", host);
  const token = broker.issueToken({
    vaultId: "vault-a",
    caller,
    profileId: "profile-a",
    capabilities,
  });
  return { broker, token, host, tabs, outputs, grants, catalogue, focusState, focusEffects };
}

function addMessageRecipient(
  setupResult: ReturnType<typeof setup>,
  taskId = "task-a",
  capabilities: BrokerCapability[] = ["message"],
) {
  const target: TerminalTabHostSnapshot = {
    ...callerTab,
    taskId,
    tabId: taskId === "task-a" ? "tab-b" : `tab-${taskId}`,
    generation: 2,
    profileId: "profile-b",
  };
  setupResult.tabs.set(taskId, [...(setupResult.tabs.get(taskId) ?? []), target]);
  setupResult.grants.set("profile-b", capabilities);
  const token = setupResult.broker.issueToken({
    vaultId: "vault-a",
    caller: target,
    profileId: "profile-b",
    capabilities,
  });
  return { target, token };
}

describe("TaskTabBroker read-only dispatcher", () => {
  it("returns authenticated caller context without echoing the token", async () => {
    const { broker, token } = setup(["discover"]);

    const response = broker.hello(token, "hello-1");

    expect(response).toMatchObject({
      v: 1,
      type: "response",
      id: "hello-1",
      ok: true,
      result: {
        brokerEpoch: expect.any(String),
        caller,
        capabilities: ["discover"],
      },
    });
    expect(JSON.stringify(response)).not.toContain(token);
    expect(broker.hello("invalid", "hello-2")).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED" },
    });
  });

  it("builds child context only for explicitly granted profiles", () => {
    const { broker } = setup();
    expect(
      broker.issueLaunchContext(
        {
          vaultId: "vault-a",
          caller,
          profileId: "profile-a",
          capabilities: [],
        },
        "/tmp/work-terminal.sock",
      ),
    ).toBeUndefined();

    const context = broker.issueLaunchContext(
      {
        vaultId: "vault-a",
        caller,
        profileId: "profile-a",
        capabilities: ["discover", "read"],
      },
      "/tmp/work-terminal.sock",
    );
    expect(context).toMatchObject({
      WORK_TERMINAL_BROKER_PROTOCOL: "1",
      WORK_TERMINAL_BROKER_ENDPOINT: "/tmp/work-terminal.sock",
      WORK_TERMINAL_TASK_ID: "task-a",
      WORK_TERMINAL_TAB_ID: "tab-a",
      WORK_TERMINAL_TAB_GENERATION: "1",
      WORK_TERMINAL_BROKER_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("authenticates a caller-bound token and dispatches versioned discovery requests", async () => {
    const { broker, token } = setup();

    await expect(broker.dispatch(token, request("listCategories"))).resolves.toEqual({
      v: 1,
      type: "response",
      id: "r1",
      ok: true,
      result: [{ id: "active", label: "Active" }],
    });
    await expect(
      broker.dispatch(token, request("listTasks", { categoryId: "active", limit: 1 }, "r2")),
    ).resolves.toMatchObject({
      ok: true,
      result: { tasks: [{ id: "task-a", categoryId: "active" }] },
    });
  });

  it("returns task, hierarchy, and cross-task tab summaries without changing focus", async () => {
    const { broker, token, tabs, focusState, focusEffects } = setup();
    tabs.set("task-b", [
      {
        taskId: "task-b",
        tabId: "tab-b",
        generation: 3,
        label: "Helper",
        sessionType: "custom",
        profileId: "profile-b",
        state: "waiting",
        processStatus: "running",
        latestSequence: "9",
      },
    ]);

    await expect(
      broker.dispatch(token, request("getTask", { taskId: "task-a" })),
    ).resolves.toMatchObject({
      ok: true,
      result: { id: "task-a", directChildIds: ["task-b"] },
    });
    await expect(
      broker.dispatch(token, request("listTabs", { taskId: "task-b" })),
    ).resolves.toMatchObject({
      ok: true,
      result: [{ taskId: "task-b", tabId: "tab-b", generation: 3, state: "waiting" }],
    });
    await expect(
      broker.dispatch(token, request("getSubtasks", { taskId: "task-a", maxDepth: 8 })),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        tasks: [{ id: "task-b", depth: 1, direct: true }],
        missingIds: ["missing"],
      },
    });
    await expect(
      broker.dispatch(token, request("getParentTasks", { taskId: "task-b" })),
    ).resolves.toMatchObject({
      ok: true,
      result: { tasks: [{ id: "task-a", depth: 1, direct: true }] },
    });
    expect(focusState).toEqual({ taskId: "task-a", tabId: "tab-a" });
    expect(focusEffects.activate).not.toHaveBeenCalled();
    expect(focusEffects.selectTask).not.toHaveBeenCalled();
    expect(focusEffects.focusTab).not.toHaveBeenCalled();
  });

  it("reads bounded clean output and rejects closed or replacement generations as stale", async () => {
    const { broker, token, tabs, outputs, focusEffects } = setup();
    const target = {
      taskId: "task-a",
      tabId: "tab-target",
      generation: 4,
      label: "Worker",
      sessionType: "claude" as const,
      state: "active" as const,
      processStatus: "running" as const,
      latestSequence: "5",
    };
    tabs.get("task-a")!.push(target);
    outputs.set("tab-target:4", {
      text: "first\nclean output",
      lineCount: 2,
      byteCount: 18,
      truncated: true,
    });

    await expect(
      broker.dispatch(
        token,
        request("readOutput", {
          target: { taskId: "task-a", tabId: "tab-target", generation: 4 },
          maxLines: 2,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { text: "first\nclean output", lineCount: 2, byteCount: 18, truncated: true },
    });
    await expect(
      broker.dispatch(
        token,
        request("readOutput", {
          target: { taskId: "task-a", tabId: "tab-target", generation: 4 },
          maxLines: 201,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "maxLines", limit: 200 } },
    });

    tabs.set("task-a", [callerTab, { ...target, generation: 5 }]);
    await expect(
      broker.dispatch(
        token,
        request("readOutput", {
          target: { taskId: "task-a", tabId: "tab-target", generation: 4 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET" } });
    tabs.set("task-a", [callerTab]);
    await expect(
      broker.dispatch(
        token,
        request("readOutput", {
          target: { taskId: "task-a", tabId: "tab-target", generation: 5 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET" } });
    expect(focusEffects.activate).not.toHaveBeenCalled();
    expect(focusEffects.selectTask).not.toHaveBeenCalled();
    expect(focusEffects.focusTab).not.toHaveBeenCalled();
  });

  it("enforces request bounds and vault scope before dispatch", async () => {
    const { broker, token, host, tabs } = setup();

    await expect(
      broker.dispatch(token, request("listTasks", { limit: 201 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "limit", limit: 200 } },
    });
    await expect(
      broker.dispatch(token, request("getSubtasks", { taskId: "task-a", maxDepth: 33 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "maxDepth", limit: 32 } },
    });
    await expect(
      broker.dispatch(token, request("getTask", { taskId: "task-a", vaultId: "vault-b" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT", details: { argument: "vaultId" } },
    });
    tabs.set(
      "task-b",
      Array.from({ length: 201 }, (_, index) => ({
        ...callerTab,
        taskId: "task-b",
        tabId: `tab-${index}`,
      })),
    );
    await expect(
      broker.dispatch(token, request("listTabs", { taskId: "task-b" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { limit: 200 } },
    });
    expect(() => broker.registerHost("vault-b", host)).toThrow(/another vault/);
    expect(() =>
      broker.issueToken({
        vaultId: "vault-b",
        caller,
        profileId: "profile-a",
        capabilities: ["discover"],
      }),
    ).toThrow(/outside the broker vault/);
  });

  it("rebinds a moved caller but expires its token when the generation is replaced", async () => {
    const { broker, token, tabs } = setup();
    tabs.set("task-a", []);
    tabs.set("task-b", [{ ...callerTab, taskId: "task-b" }]);

    await expect(broker.dispatch(token, request("listCategories"))).resolves.toMatchObject({
      ok: true,
    });
    const movedDiagnostics = broker.getDiagnostics();
    expect(movedDiagnostics[movedDiagnostics.length - 1]?.caller.taskId).toBe("task-b");

    tabs.set("task-b", [{ ...callerTab, taskId: "task-b", generation: 2 }]);
    await expect(broker.dispatch(token, request("listCategories"))).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED" },
    });
  });

  it("rate limits output reads and keeps diagnostics free of tokens and output", async () => {
    const { broker, token, outputs } = setup();
    outputs.set("tab-a:1", {
      text: "sensitive terminal output",
      lineCount: 1,
      byteCount: 25,
      truncated: false,
    });
    const outputRequest = request("readOutput", { target: caller });

    for (let count = 0; count < 60; count++) {
      const response = await broker.dispatch(token, { ...outputRequest, id: `read-${count}` });
      expect(response.ok).toBe(true);
    }
    await expect(
      broker.dispatch(token, { ...outputRequest, id: "read-limited" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED", retryable: true },
    });

    const diagnostics = JSON.stringify(broker.getDiagnostics());
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain("sensitive terminal output");
    const audit = broker.getDiagnostics();
    expect(audit[audit.length - 1]).toMatchObject({
      method: "readOutput",
      allowed: false,
      errorCode: "RATE_LIMITED",
    });
  });

  it("fails closed for invalid tokens and exact capability denial or revocation", async () => {
    const { broker, token, grants } = setup(["discover"]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(broker.dispatch("not-a-token", request("listCategories"))).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", retryable: false },
    });
    await expect(broker.dispatch(token, request("readOutput"))).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        details: { requiredCapability: "read" },
      },
    });

    grants.set("profile-a", []);
    await expect(broker.dispatch(token, request("listCategories"))).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        details: { requiredCapability: "discover" },
      },
    });
  });
});

describe("TaskTabBroker mailbox", () => {
  it("delivers same-task and cross-task messages only through recipient mailboxes", async () => {
    const context = setup(["message"]);
    const sameTask = addMessageRecipient(context);

    await expect(
      context.broker.dispatch(
        context.token,
        request("sendMessage", {
          target: sameTask.target,
          clientMessageId: "same-1",
          kind: "status",
          payload: { text: "ready" },
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { messageId: expect.any(String), acceptedAt: expect.any(Number) },
    });
    await expect(
      context.broker.dispatch(sameTask.token, request("receiveMessages")),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        messages: [
          {
            clientMessageId: "same-1",
            sender: caller,
            recipient: {
              taskId: sameTask.target.taskId,
              tabId: sameTask.target.tabId,
              generation: sameTask.target.generation,
            },
            kind: "status",
            payload: { text: "ready" },
          },
        ],
      },
    });

    const crossTask = addMessageRecipient(context, "task-b");
    await expect(
      context.broker.dispatch(
        context.token,
        request("sendMessage", {
          target: crossTask.target,
          clientMessageId: "cross-1",
          payload: ["structured", 1],
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      context.broker.dispatch(crossTask.token, request("receiveMessages")),
    ).resolves.toMatchObject({
      ok: true,
      result: { messages: [{ clientMessageId: "cross-1", payload: ["structured", 1] }] },
    });
    expect(context.outputs.size).toBe(0);
    expect(context.focusEffects.focusTab).not.toHaveBeenCalled();
    const audit = context.broker.getDiagnostics();
    expect(audit[audit.length - 2]).toMatchObject({
      method: "sendMessage",
      target: {
        taskId: crossTask.target.taskId,
        tabId: crossTask.target.tabId,
        generation: crossTask.target.generation,
      },
      allowed: true,
      byteCount: 16,
    });
    expect(JSON.stringify(audit)).not.toContain("structured");
    expect(JSON.stringify(audit)).not.toContain(context.token);
  });

  it("deduplicates sends and acknowledges messages idempotently", async () => {
    const context = setup(["message"]);
    const recipient = addMessageRecipient(context);
    const send = request("sendMessage", {
      target: recipient.target,
      clientMessageId: "retry-1",
      payload: "once",
    });

    const first = await context.broker.dispatch(context.token, send);
    const retry = await context.broker.dispatch(context.token, { ...send, id: "retry" });
    expect(retry).toEqual({ ...first, id: "retry" });

    const received = await context.broker.dispatch(
      recipient.token,
      request("receiveMessages", {}, "receive"),
    );
    expect(received).toMatchObject({ ok: true, result: { messages: [{ payload: "once" }] } });
    const messageId = (received as any).result.messages[0].messageId;
    await expect(
      context.broker.dispatch(
        recipient.token,
        request("ackMessages", { messageIds: [messageId, "unknown-id"] }, "ack-1"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { acked: [messageId], alreadyAcked: [], unknown: ["unknown-id"] },
    });
    await expect(
      context.broker.dispatch(
        recipient.token,
        request("ackMessages", { messageIds: [messageId] }, "ack-2"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { acked: [], alreadyAcked: [messageId], unknown: [] },
    });
    await expect(
      context.broker.dispatch(recipient.token, request("receiveMessages", {}, "receive-2")),
    ).resolves.toMatchObject({ ok: true, result: { messages: [] } });
  });

  it("retains unacknowledged messages through runtime handoff", async () => {
    const context = setup(["message"]);
    const recipient = addMessageRecipient(context);
    await context.broker.dispatch(
      context.token,
      request("sendMessage", {
        target: recipient.target,
        clientMessageId: "before-reload",
        payload: { durableForReload: true },
      }),
    );

    const replacement = new TaskTabBroker({
      vaultId: "vault-a",
      catalogue: context.catalogue,
      getProfileCapabilities: (profileId) => context.grants.get(profileId) ?? [],
      runtimeState: context.broker.exportRuntimeState(),
    });
    replacement.registerHost("vault-a", context.host);

    await expect(
      replacement.dispatch(recipient.token, request("receiveMessages")),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        messages: [{ clientMessageId: "before-reload", payload: { durableForReload: true } }],
      },
    });
  });

  it("requires message capability from both caller and recipient", async () => {
    const deniedCaller = setup(["discover"]);
    const recipient = addMessageRecipient(deniedCaller);
    await expect(
      deniedCaller.broker.dispatch(
        deniedCaller.token,
        request("sendMessage", {
          target: recipient.target,
          clientMessageId: "denied-caller",
          payload: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_DENIED", details: { requiredCapability: "message" } },
    });

    const deniedRecipient = setup(["message"]);
    const recipientWithoutGrant = addMessageRecipient(deniedRecipient, "task-a", ["discover"]);
    await expect(
      deniedRecipient.broker.dispatch(
        deniedRecipient.token,
        request("sendMessage", {
          target: recipientWithoutGrant.target,
          clientMessageId: "denied-recipient",
          payload: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        details: { requiredCapability: "message", recipient: true },
      },
    });
  });

  it("enforces payload, receive, acknowledgement, and send-rate limits", async () => {
    const context = setup(["message"]);
    const recipient = addMessageRecipient(context);

    await expect(
      context.broker.dispatch(
        context.token,
        request("sendMessage", {
          target: recipient.target,
          clientMessageId: "too-large",
          payload: "x".repeat(8_193),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "payload", limit: 8192 } },
    });
    await expect(
      context.broker.dispatch(recipient.token, request("receiveMessages", { limit: 51 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "limit", limit: 50 } },
    });
    await expect(
      context.broker.dispatch(
        recipient.token,
        request("ackMessages", { messageIds: Array.from({ length: 51 }, (_, i) => `m-${i}`) }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "messageIds", limit: 50 } },
    });

    const rateContext = setup(["message"]);
    const rateRecipient = addMessageRecipient(rateContext);
    for (let count = 0; count < 30; count++) {
      const response = await rateContext.broker.dispatch(
        rateContext.token,
        request(
          "sendMessage",
          {
            target: rateRecipient.target,
            clientMessageId: `message-${count}`,
            payload: count,
          },
          `send-${count}`,
        ),
      );
      expect(response.ok).toBe(true);
    }
    await expect(
      rateContext.broker.dispatch(
        rateContext.token,
        request(
          "sendMessage",
          { target: rateRecipient.target, clientMessageId: "rate-limited", payload: 31 },
          "send-limited",
        ),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true } });

    let time = 0;
    const queueContext = setup(["message"], () => time);
    const queueRecipient = addMessageRecipient(queueContext);
    for (let count = 0; count < 100; count++) {
      if (count > 0 && count % 25 === 0) time += 60_001;
      const response = await queueContext.broker.dispatch(
        queueContext.token,
        request(
          "sendMessage",
          {
            target: queueRecipient.target,
            clientMessageId: `queued-${count}`,
            payload: count,
          },
          `queue-${count}`,
        ),
      );
      expect(response.ok).toBe(true);
    }
    await expect(
      queueContext.broker.dispatch(
        queueContext.token,
        request(
          "sendMessage",
          { target: queueRecipient.target, clientMessageId: "mailbox-full", payload: 101 },
          "queue-full",
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "MAILBOX_FULL", details: { resource: "messages", limit: 100 } },
    });

    time = 0;
    const byteContext = setup(["message"], () => time);
    const byteRecipient = addMessageRecipient(byteContext);
    for (let count = 0; count < 32; count++) {
      if (count === 25) time += 60_001;
      const response = await byteContext.broker.dispatch(
        byteContext.token,
        request(
          "sendMessage",
          {
            target: byteRecipient.target,
            clientMessageId: `bytes-${count}`,
            payload: "x".repeat(8_190),
          },
          `bytes-${count}`,
        ),
      );
      expect(response.ok).toBe(true);
    }
    await expect(
      byteContext.broker.dispatch(
        byteContext.token,
        request(
          "sendMessage",
          { target: byteRecipient.target, clientMessageId: "bytes-full", payload: null },
          "bytes-full",
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "MAILBOX_FULL", details: { resource: "bytes", limit: 262144 } },
    });
  });

  it("rejects stale, unavailable, and disconnected recipients with structured failures", async () => {
    const context = setup(["message"]);
    const recipient = addMessageRecipient(context, "task-b");
    const send = (target: TerminalTabTarget, id: string) =>
      context.broker.dispatch(
        context.token,
        request("sendMessage", { target, clientMessageId: id, payload: "hello" }, id),
      );

    await expect(
      send({ ...recipient.target, generation: 1 }, "stale-generation"),
    ).resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET" } });

    const unregistered: TerminalTabHostSnapshot = {
      ...recipient.target,
      tabId: "tab-unregistered",
      profileId: "profile-c",
    };
    context.tabs.get("task-b")!.push(unregistered);
    await expect(send(unregistered, "not-enabled")).resolves.toMatchObject({
      ok: false,
      error: { code: "TARGET_UNAVAILABLE" },
    });

    await expect(send(recipient.target, "before-replacement")).resolves.toMatchObject({
      ok: true,
    });
    const replacement = { ...recipient.target, generation: 3 };
    context.tabs.set("task-b", [replacement]);
    const replacementToken = context.broker.issueToken({
      vaultId: "vault-a",
      caller: replacement,
      profileId: "profile-b",
      capabilities: ["message"],
    });
    await expect(
      context.broker.dispatch(replacementToken, request("receiveMessages", {}, "replacement")),
    ).resolves.toMatchObject({ ok: true, result: { messages: [] } });
    await expect(send(recipient.target, "replaced")).resolves.toMatchObject({
      ok: false,
      error: { code: "STALE_TARGET" },
    });

    context.tabs.set("task-b", []);
    await expect(send(replacement, "disconnected")).resolves.toMatchObject({
      ok: false,
      error: { code: "STALE_TARGET" },
    });
  });
});
