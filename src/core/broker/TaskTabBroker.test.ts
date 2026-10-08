import { describe, expect, it, vi } from "vitest";
import type {
  CleanOutputRead,
  TerminalLifecycleEvent,
  TerminalLifecycleListener,
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

function setup(
  capabilities: BrokerCapability[] = ["discover", "read", "wait"],
  now?: () => number,
) {
  const tabs = new Map<string, TerminalTabHostSnapshot[]>([["task-a", [callerTab]]]);
  const outputs = new Map<string, CleanOutputRead>();
  const lifecycleListeners = new Map<string, Set<TerminalLifecycleListener>>();
  const targetKey = (target: TerminalTabTarget) =>
    `${target.taskId}:${target.tabId}:${target.generation}`;
  const focusState = { taskId: "task-a", tabId: "tab-a" };
  const focusEffects = { activate: vi.fn(), selectTask: vi.fn(), focusTab: vi.fn() };
  const host = {
    getTabHostSnapshots: (taskId: string) => tabs.get(taskId) ?? [],
    getAllTabHostSnapshots: () => [...tabs.values()].flat(),
    readTabOutput: (target: TerminalTabTarget) =>
      outputs.get(`${target.tabId}:${target.generation}`) ?? null,
    onTabLifecycle: (target: TerminalTabTarget, listener: TerminalLifecycleListener) => {
      if (!(tabs.get(target.taskId) ?? []).some((tab) => targetKey(tab) === targetKey(target))) {
        return null;
      }
      const listeners = lifecycleListeners.get(targetKey(target)) ?? new Set();
      listeners.add(listener);
      lifecycleListeners.set(targetKey(target), listeners);
      return () => listeners.delete(listener);
    },
    createProfileTab: vi.fn(),
    promptTab: vi.fn(),
    ...focusEffects,
  } as BrokerTerminalHost &
    typeof focusEffects & {
      createProfileTab: ReturnType<typeof vi.fn>;
      promptTab: ReturnType<typeof vi.fn>;
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
  const emitLifecycle = (event: TerminalLifecycleEvent) => {
    for (const listener of lifecycleListeners.get(targetKey(event.target)) ?? []) listener(event);
  };
  return {
    broker,
    token,
    host,
    tabs,
    outputs,
    grants,
    catalogue,
    focusState,
    focusEffects,
    emitLifecycle,
    lifecycleListeners,
  };
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

  it("creates a profile-backed tab for a valid task without changing focus", async () => {
    const { broker, token, host, tabs, focusState, focusEffects } = setup(["create-tab"]);
    const created: TerminalTabHostSnapshot = {
      taskId: "task-b",
      tabId: "tab-created",
      generation: 1,
      label: "Worker",
      sessionType: "claude",
      profileId: "profile-b",
      state: "active",
      processStatus: "running",
      latestSequence: "0",
    };
    host.createProfileTab.mockImplementation(async () => {
      tabs.set("task-b", [created]);
      return { status: "created", tab: created };
    });

    await expect(
      broker.dispatch(
        token,
        request("createTab", {
          taskId: "task-b",
          profileId: "profile-b",
          initialPrompt: "Start with the failing test",
        }),
      ),
    ).resolves.toEqual({ v: 1, type: "response", id: "r1", ok: true, result: created });
    expect(host.createProfileTab).toHaveBeenCalledWith(
      "task-b",
      "profile-b",
      "Start with the failing test",
    );
    expect(focusState).toEqual({ taskId: "task-a", tabId: "tab-a" });
    expect(focusEffects.activate).not.toHaveBeenCalled();
    expect(focusEffects.selectTask).not.toHaveBeenCalled();
    expect(focusEffects.focusTab).not.toHaveBeenCalled();

    host.createProfileTab.mockResolvedValueOnce({ status: "profile-not-found" });
    await expect(
      broker.dispatch(
        token,
        request("createTab", { taskId: "task-b", profileId: "missing-profile" }, "missing-profile"),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    host.createProfileTab.mockResolvedValueOnce({ status: "invalid-profile" });
    await expect(
      broker.dispatch(
        token,
        request("createTab", { taskId: "task-b", profileId: "shell-profile" }, "shell-profile"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT", details: { argument: "profileId" } },
    });
    await expect(
      broker.dispatch(
        token,
        request("createTab", { taskId: "missing-task", profileId: "profile-b" }, "missing-task"),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("enforces separate mutation grants and UTF-8 prompt bounds before host dispatch", async () => {
    const { broker, token, host, tabs } = setup(["create-tab"]);

    await expect(
      broker.dispatch(token, request("promptTab", { target: caller, prompt: "Continue" })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_DENIED",
        details: { requiredCapability: "prompt-tab" },
      },
    });
    await expect(
      broker.dispatch(
        token,
        request("createTab", {
          taskId: "task-b",
          profileId: "profile-b",
          initialPrompt: "😀".repeat(4097),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "LIMIT_EXCEEDED",
        details: { argument: "initialPrompt", limit: 16 * 1024 },
      },
    });
    await expect(
      broker.dispatch(token, request("createTab", { taskId: "task-b", profileId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT", details: { argument: "profileId" } },
    });
    tabs.set(
      "task-b",
      Array.from({ length: 32 }, (_, index) => ({
        ...callerTab,
        taskId: "task-b",
        tabId: `task-b-tab-${index}`,
      })),
    );
    await expect(
      broker.dispatch(
        token,
        request("createTab", { taskId: "task-b", profileId: "profile-b" }, "tab-limit"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { limit: 32 } },
    });
    expect(host.createProfileTab).not.toHaveBeenCalled();
    expect(host.promptTab).not.toHaveBeenCalled();

    const promptOnly = setup(["prompt-tab"]);
    await expect(
      promptOnly.broker.dispatch(
        promptOnly.token,
        request("promptTab", { target: caller, prompt: "😀".repeat(4097) }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "LIMIT_EXCEEDED",
        details: { argument: "prompt", limit: 16 * 1024 },
      },
    });
    expect(promptOnly.host.promptTab).not.toHaveBeenCalled();
  });

  it("rate limits remote tab creation independently", async () => {
    const { broker, token, host } = setup(["create-tab"]);
    host.createProfileTab.mockResolvedValue({
      status: "created",
      tab: {
        taskId: "task-b",
        tabId: "tab-created",
        generation: 1,
        label: "Worker",
        sessionType: "claude",
        state: "active",
        processStatus: "running",
        latestSequence: "0",
      },
    });

    for (let count = 0; count < 6; count++) {
      const response = await broker.dispatch(
        token,
        request("createTab", { taskId: "task-b", profileId: "profile-b" }, `create-${count}`),
      );
      expect(response.ok).toBe(true);
    }
    await expect(
      broker.dispatch(
        token,
        request("createTab", { taskId: "task-b", profileId: "profile-b" }, "create-limited"),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true } });
  });

  it("prompts only an existing generation-pinned tab without changing focus", async () => {
    const { broker, token, host, tabs, focusEffects } = setup(["prompt-tab"]);
    const target: TerminalTabTarget = {
      taskId: "task-b",
      tabId: "tab-target",
      generation: 4,
    };
    tabs.set("task-b", [
      {
        ...target,
        label: "Worker",
        sessionType: "claude",
        state: "waiting",
        processStatus: "running",
        latestSequence: "5",
      },
    ]);
    host.promptTab.mockReturnValue("accepted");

    await expect(
      broker.dispatch(token, request("promptTab", { target, prompt: "Continue" })),
    ).resolves.toEqual({
      v: 1,
      type: "response",
      id: "r1",
      ok: true,
      result: { target, affectedGeneration: 4 },
    });
    expect(host.promptTab).toHaveBeenCalledWith(target, "Continue");

    tabs.set("task-b", [{ ...tabs.get("task-b")![0], generation: 5 }]);
    await expect(
      broker.dispatch(token, request("promptTab", { target, prompt: "Late" }, "stale")),
    ).resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET" } });
    expect(host.promptTab).toHaveBeenCalledOnce();
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

describe("TaskTabBroker lifecycle waits", () => {
  it("returns current requested, unknown, and exited states distinctly", async () => {
    const { broker, token, tabs, lifecycleListeners } = setup(["wait"]);

    await expect(
      broker.dispatch(token, request("waitForTab", { target: caller, states: ["active"] })),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "state", state: "active", sequence: "2" },
    });

    tabs.set("task-a", [{ ...callerTab, state: "unknown", latestSequence: "3" }]);
    await expect(
      broker.dispatch(token, request("waitForTab", { target: caller, states: ["idle"] })),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "unknown", sequence: "3" },
    });

    tabs.set("task-a", [{ ...callerTab, processStatus: "exited", latestSequence: "4" }]);
    await expect(
      broker.dispatch(token, request("waitForTab", { target: caller, states: ["idle"] })),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: "exit", exitCode: null, signal: null, sequence: "4" },
    });
    expect([...lifecycleListeners.values()].flatMap((listeners) => [...listeners])).toHaveLength(0);
  });

  it("waits for ordered state or exit events without polling and pins the generation", async () => {
    const { broker, token, emitLifecycle, lifecycleListeners } = setup(["wait"]);
    const stateWait = broker.dispatch(
      token,
      request("waitForTab", { target: caller, states: ["idle"], timeoutMs: 1_000 }),
    );
    await Promise.resolve();

    emitLifecycle({
      type: "state",
      target: caller,
      state: "idle",
      sequence: "3",
    });
    await expect(stateWait).resolves.toMatchObject({
      ok: true,
      result: { kind: "state", state: "idle", sequence: "3" },
    });
    expect(lifecycleListeners.get("task-a:tab-a:1")?.size).toBe(0);

    const exitWait = broker.dispatch(
      token,
      request("waitForTab", { target: caller, states: ["waiting"] }),
    );
    await Promise.resolve();
    emitLifecycle({
      type: "exit",
      target: caller,
      exitCode: 7,
      signal: null,
      sequence: "4",
    });
    await expect(exitWait).resolves.toMatchObject({
      ok: true,
      result: { kind: "exit", exitCode: 7, signal: null, sequence: "4" },
    });
  });

  it("returns timeout and stale outcomes and always removes its listener", async () => {
    vi.useFakeTimers();
    try {
      const { broker, token, emitLifecycle, lifecycleListeners } = setup(["wait"]);
      const timeoutWait = broker.dispatch(
        token,
        request("waitForTab", { target: caller, states: ["idle"], timeoutMs: 25 }),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(timeoutWait).resolves.toMatchObject({
        ok: true,
        result: { kind: "timeout" },
      });
      expect(lifecycleListeners.get("task-a:tab-a:1")?.size).toBe(0);

      const staleWait = broker.dispatch(
        token,
        request("waitForTab", { target: caller, states: ["waiting"] }),
      );
      await Promise.resolve();
      emitLifecycle({ type: "closed", target: caller, sequence: "5" });
      await expect(staleWait).resolves.toMatchObject({
        ok: false,
        error: { code: "STALE_TARGET" },
      });
      expect(lifecycleListeners.get("task-a:tab-a:1")?.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels and cleans up a pending wait when its transport signal aborts", async () => {
    const { broker, token, lifecycleListeners } = setup(["wait"]);
    const controller = new AbortController();
    const pending = broker.dispatch(
      token,
      request("waitForTab", { target: caller, states: ["idle"] }),
      controller.signal,
    );
    await Promise.resolve();

    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "BROKER_RELOADING", retryable: true },
    });
    expect(lifecycleListeners.get("task-a:tab-a:1")?.size).toBe(0);
  });

  it("enforces wait arguments, capability, concurrency, and rate limits", async () => {
    const denied = setup(["discover"]);
    await expect(
      denied.broker.dispatch(
        denied.token,
        request("waitForTab", { target: caller, states: ["idle"] }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_DENIED", details: { requiredCapability: "wait" } },
    });

    const { broker, token } = setup(["wait"]);
    await expect(
      broker.dispatch(token, request("waitForTab", { target: caller, states: [] })),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    await expect(
      broker.dispatch(
        token,
        request("waitForTab", { target: caller, states: ["idle"], timeoutMs: 600_001 }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { argument: "timeoutMs", limit: 600_000 } },
    });

    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller, index) =>
      broker.dispatch(
        token,
        request(
          "waitForTab",
          { target: caller, states: ["idle"], timeoutMs: 60_000 },
          `wait-${index}`,
        ),
        controller.signal,
      ),
    );
    await Promise.resolve();
    await expect(
      broker.dispatch(
        token,
        request("waitForTab", { target: caller, states: ["idle"] }, "wait-overflow"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "LIMIT_EXCEEDED", details: { limit: 16 } },
    });
    controllers.forEach((controller) => controller.abort());
    await Promise.all(pending);

    for (let index = 0; index < 11; index++) {
      await expect(
        broker.dispatch(
          token,
          request("waitForTab", { target: caller, states: ["active"] }, `rate-${index}`),
        ),
      ).resolves.toMatchObject({ ok: true, result: { kind: "state", state: "active" } });
    }
    await expect(
      broker.dispatch(
        token,
        request("waitForTab", { target: caller, states: ["active"] }, "rate-overflow"),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
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
