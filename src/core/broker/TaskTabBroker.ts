import type { BrokerCapability } from "../agents/AgentProfile";
import type {
  CleanOutputRead,
  TerminalHostRuntimeState,
  TerminalLifecycleEvent,
  TerminalLifecycleListener,
  TerminalTabHostSnapshot,
  TerminalTabTarget,
} from "../terminal/TerminalHost";
import { electronRequire } from "../utils";
import type {
  TaskCategorySummary,
  TaskListResult,
  TaskSummary,
  TaskTraversalOptions,
  TaskTraversalResult,
} from "../../framework/TaskCatalogue";

export const BROKER_PROTOCOL_VERSION = 1;
export const BROKER_FRAME_MAX_BYTES = 65_536;
export const BROKER_IDENTIFIER_MAX_BYTES = 128;
export const BROKER_LIST_DEFAULT_LIMIT = 50;
export const BROKER_LIST_MAX_LIMIT = 200;
export const BROKER_HIERARCHY_DEFAULT_DEPTH = 8;
export const BROKER_HIERARCHY_MAX_DEPTH = 32;
export const BROKER_HIERARCHY_MAX_RESULTS = 500;
export const BROKER_OUTPUT_DEFAULT_LINES = 50;
export const BROKER_OUTPUT_MAX_LINES = 200;
export const BROKER_OUTPUT_MAX_BYTES = 48 * 1024;
export const BROKER_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
export const BROKER_WAIT_MAX_TIMEOUT_MS = 10 * 60_000;
export const BROKER_MESSAGE_KIND_MAX_BYTES = 64;
export const BROKER_MESSAGE_PAYLOAD_MAX_BYTES = 8 * 1024;
export const BROKER_MAILBOX_MAX_MESSAGES = 100;
export const BROKER_MAILBOX_MAX_BYTES = 256 * 1024;
export const BROKER_MAILBOX_DEFAULT_LIMIT = 20;
export const BROKER_MAILBOX_MAX_LIMIT = 50;
export const BROKER_ACK_MAX_MESSAGES = 50;
export const BROKER_PROMPT_MAX_BYTES = 16 * 1024;
export const BROKER_TABS_PER_TASK_MAX = 32;

const RATE_WINDOW_MS = 60_000;
const GENERAL_RATE_LIMIT = 120;
const OUTPUT_RATE_LIMIT = 60;
const WAIT_RATE_LIMIT = 30;
const CALLER_WAIT_LIMIT = 16;
const BROKER_WAIT_LIMIT = 128;
const MESSAGE_RATE_LIMIT = 30;
const CREATE_RATE_LIMIT = 6;
const PROMPT_RATE_LIMIT = 20;
const INTERRUPT_RATE_LIMIT = 10;
const CLOSE_RATE_LIMIT = 5;
const AUTH_FAILURE_RATE_LIMIT = 20;
const TOMBSTONE_TTL_MS = 60 * 60_000;
const TOMBSTONE_LIMIT = 10_000;
const ACK_RECORD_TTL_MS = 60 * 60_000;
const ACK_RECORD_LIMIT = 10_000;
const AUDIT_LIMIT = 1_000;

export type { BrokerCapability } from "../agents/AgentProfile";
export type BrokerMethod =
  | "listCategories"
  | "listTasks"
  | "getTask"
  | "listTabs"
  | "getSubtasks"
  | "getParentTasks"
  | "readOutput"
  | "waitForTab"
  | "sendMessage"
  | "receiveMessages"
  | "ackMessages"
  | "createTab"
  | "promptTab"
  | "interruptTab"
  | "closeTab";

export interface BrokerRequest {
  v: number;
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface BrokerError {
  code:
    | "INVALID_FRAME"
    | "UNSUPPORTED_VERSION"
    | "AUTH_REQUIRED"
    | "AUTH_FAILED"
    | "CAPABILITY_DENIED"
    | "INVALID_ARGUMENT"
    | "LIMIT_EXCEEDED"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "STALE_TARGET"
    | "TARGET_EXITED"
    | "TARGET_UNAVAILABLE"
    | "BROKER_RELOADING"
    | "MAILBOX_FULL"
    | "INTERNAL";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type BrokerResponse =
  | { v: 1; type: "response"; id: string | null; ok: true; result: unknown }
  | { v: 1; type: "response"; id: string | null; ok: false; error: BrokerError };

export interface BrokerTaskCatalogue {
  listCategories(): Promise<TaskCategorySummary[]>;
  listTasks(options?: {
    categoryId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<TaskListResult>;
  getTask(taskId: string): Promise<TaskSummary | null>;
  getSubtasks(taskId: string, options?: TaskTraversalOptions): Promise<TaskTraversalResult | null>;
  getParentTasks(
    taskId: string,
    options?: TaskTraversalOptions,
  ): Promise<TaskTraversalResult | null>;
}

export type BrokerCreateTabResult =
  | { status: "created"; tab: TerminalTabHostSnapshot }
  | { status: "profile-not-found" }
  | { status: "invalid-profile" }
  | { status: "unavailable" };

/** Handle-free terminal host primitives used by the broker. */
export interface BrokerTerminalHost {
  getTabHostSnapshots(taskId: string): readonly TerminalTabHostSnapshot[];
  getAllTabHostSnapshots(): readonly TerminalTabHostSnapshot[];
  readTabOutput(
    target: TerminalTabTarget,
    options: { maxLines: number; maxBytes: number },
  ): CleanOutputRead | null;
  onTabLifecycle(
    target: TerminalTabTarget,
    listener: TerminalLifecycleListener,
  ): (() => void) | null;
  createProfileTab?(
    taskId: string,
    profileId: string,
    initialPrompt?: string,
  ): Promise<BrokerCreateTabResult>;
  promptTab?(
    target: TerminalTabTarget,
    prompt: string,
  ): "accepted" | "exited" | "unavailable" | null;
  interruptTab?(target: TerminalTabTarget): "accepted" | "exited" | "unavailable" | null;
  closeTab?(target: TerminalTabTarget): { processWasRunning: boolean } | null;
}

export interface BrokerCallerGrant {
  vaultId: string;
  caller: TerminalTabTarget;
  profileId: string;
  capabilities: readonly BrokerCapability[];
}

export interface BrokerMailboxMessage {
  readonly messageId: string;
  readonly clientMessageId: string;
  readonly sender: TerminalTabTarget;
  readonly recipient: TerminalTabTarget;
  readonly acceptedAt: number;
  readonly kind?: string;
  readonly payload: unknown;
}

export interface BrokerMailboxAvailableEvent {
  readonly sequence: string;
  readonly pending: number;
}

export interface BrokerMessageAcceptance {
  readonly messageId: string;
  readonly acceptedAt: number;
  readonly target: TerminalTabTarget;
}

export interface BrokerAuditEntry {
  readonly timestamp: number;
  readonly brokerEpoch: string;
  readonly caller: TerminalTabTarget;
  readonly target?: TerminalTabTarget;
  readonly method: string;
  readonly allowed: boolean;
  readonly errorCode?: BrokerError["code"];
  readonly byteCount: number;
  readonly durationMs: number;
}

interface StoredCallerGrant extends BrokerCallerGrant {
  digest: Buffer;
  requestTimes: number[];
  outputRequestTimes: number[];
  waitRequestTimes: number[];
  messageRequestTimes: number[];
  createRequestTimes: number[];
  promptRequestTimes: number[];
  interruptRequestTimes: number[];
  closeRequestTimes: number[];
  activeWaits: number;
}

interface StoredMessage extends Omit<BrokerMailboxMessage, "payload"> {
  payloadJson: string;
  byteCount?: number;
}

interface StoredMailbox {
  messages: StoredMessage[];
  byteCount: number;
}

interface DeliveryRecord {
  acceptance: BrokerMessageAcceptance;
  recipientKey: string;
  acknowledgedAt?: number;
}

interface AcknowledgedRecord {
  dedupKey: string;
  recipientKey: string;
  acknowledgedAt: number;
}

interface KnownTab {
  observedAt: number;
}

export interface BrokerRuntimeState {
  vaultId: string;
  callers: Array<{
    grant: BrokerCallerGrant;
    digest: string;
    requestTimes: number[];
    outputRequestTimes: number[];
    waitRequestTimes: number[];
    messageRequestTimes: number[];
    createRequestTimes?: number[];
    promptRequestTimes?: number[];
    interruptRequestTimes?: number[];
    closeRequestTimes?: number[];
  }>;
  knownTabs: Array<[string, KnownTab]>;
  mailboxes: Array<[string, StoredMailbox]>;
  deliveryRecords: Array<[string, DeliveryRecord]>;
  acknowledgedRecords: Array<[string, AcknowledgedRecord]>;
  failedAuthTimes: number[];
  audit: BrokerAuditEntry[];
}

export class TaskTabBroker {
  private readonly vaultId: string;
  private readonly catalogue: BrokerTaskCatalogue;
  private readonly getProfileCapabilities: (profileId: string) => readonly string[];
  private readonly now: () => number;
  private readonly brokerEpoch: string;
  private readonly hosts = new Set<BrokerTerminalHost>();
  private readonly callers: StoredCallerGrant[] = [];
  private readonly knownTabs = new Map<string, KnownTab>();
  private readonly mailboxes = new Map<string, StoredMailbox>();
  private readonly deliveryRecords = new Map<string, DeliveryRecord>();
  private readonly acknowledgedRecords = new Map<string, AcknowledgedRecord>();
  private readonly mailboxListeners = new Map<
    string,
    Set<(event: BrokerMailboxAvailableEvent) => void>
  >();
  private mailboxEventSequence = "0";
  private readonly failedAuthTimes: number[] = [];
  private readonly audit: BrokerAuditEntry[] = [];
  private readonly pendingTabCreations = new Map<string, number>();
  private activeWaits = 0;

  constructor(options: {
    vaultId: string;
    catalogue: BrokerTaskCatalogue;
    getProfileCapabilities: (profileId: string) => readonly string[];
    now?: () => number;
    runtimeState?: BrokerRuntimeState;
  }) {
    if (!validIdentifier(options.vaultId)) throw new Error("vaultId is invalid");
    this.vaultId = options.vaultId;
    this.catalogue = options.catalogue;
    this.getProfileCapabilities = options.getProfileCapabilities;
    this.now = options.now ?? Date.now;
    this.brokerEpoch = cryptoModule().randomUUID();
    const runtime = options.runtimeState;
    if (runtime) {
      if (runtime.vaultId !== this.vaultId)
        throw new Error("Broker runtime belongs to another vault");
      for (const caller of runtime.callers) {
        this.callers.push({
          ...caller.grant,
          caller: Object.freeze({ ...caller.grant.caller }),
          capabilities: Object.freeze([...caller.grant.capabilities]),
          digest: Buffer.from(caller.digest, "base64"),
          requestTimes: [...caller.requestTimes],
          outputRequestTimes: [...caller.outputRequestTimes],
          waitRequestTimes: [...(caller.waitRequestTimes ?? [])],
          messageRequestTimes: [...(caller.messageRequestTimes ?? [])],
          createRequestTimes: [...(caller.createRequestTimes ?? [])],
          promptRequestTimes: [...(caller.promptRequestTimes ?? [])],
          interruptRequestTimes: [...(caller.interruptRequestTimes ?? [])],
          closeRequestTimes: [...(caller.closeRequestTimes ?? [])],
          activeWaits: 0,
        });
      }
      for (const [tabId, known] of runtime.knownTabs) {
        this.knownTabs.set(tabId, { ...known });
      }
      for (const [key, mailbox] of runtime.mailboxes ?? []) {
        const messages = mailbox.messages.map((message) => ({
          ...message,
          sender: { ...message.sender },
          recipient: { ...message.recipient },
          byteCount: message.byteCount ?? encodedSize(toMailboxMessage(message)),
        }));
        this.mailboxes.set(key, {
          messages,
          byteCount: messages.reduce((total, message) => total + (message.byteCount ?? 0), 0),
        });
      }
      for (const [key, record] of runtime.deliveryRecords ?? []) {
        this.deliveryRecords.set(key, {
          ...record,
          acceptance: { ...record.acceptance, target: { ...record.acceptance.target } },
        });
      }
      for (const [key, record] of runtime.acknowledgedRecords ?? []) {
        this.acknowledgedRecords.set(key, { ...record });
      }
      this.failedAuthTimes.push(...runtime.failedAuthTimes);
      this.audit.push(...runtime.audit);
    }
  }

  exportRuntimeState(): BrokerRuntimeState {
    return {
      vaultId: this.vaultId,
      callers: this.callers.map((caller) => ({
        grant: {
          vaultId: caller.vaultId,
          caller: { ...caller.caller },
          profileId: caller.profileId,
          capabilities: [...caller.capabilities],
        },
        digest: caller.digest.toString("base64"),
        requestTimes: [...caller.requestTimes],
        outputRequestTimes: [...caller.outputRequestTimes],
        waitRequestTimes: [...caller.waitRequestTimes],
        messageRequestTimes: [...caller.messageRequestTimes],
        createRequestTimes: [...caller.createRequestTimes],
        promptRequestTimes: [...caller.promptRequestTimes],
        interruptRequestTimes: [...caller.interruptRequestTimes],
        closeRequestTimes: [...caller.closeRequestTimes],
      })),
      knownTabs: [...this.knownTabs].map(([tabId, known]) => [tabId, { ...known }]),
      mailboxes: [...this.mailboxes].map(([key, mailbox]) => [
        key,
        {
          messages: mailbox.messages.map((message) => ({
            ...message,
            sender: { ...message.sender },
            recipient: { ...message.recipient },
          })),
          byteCount: mailbox.byteCount,
        },
      ]),
      deliveryRecords: [...this.deliveryRecords].map(([key, record]) => [
        key,
        {
          ...record,
          acceptance: { ...record.acceptance, target: { ...record.acceptance.target } },
        },
      ]),
      acknowledgedRecords: [...this.acknowledgedRecords].map(([key, record]) => [
        key,
        { ...record },
      ]),
      failedAuthTimes: [...this.failedAuthTimes],
      audit: [...this.audit],
    };
  }

  registerHost(vaultId: string, host: BrokerTerminalHost): () => void {
    if (vaultId !== this.vaultId) throw new Error("Cannot register a host from another vault");
    this.hosts.add(host);
    for (const tab of host.getAllTabHostSnapshots()) this.rememberTab(tab);
    return () => this.hosts.delete(host);
  }

  issueToken(grant: BrokerCallerGrant): string {
    if (
      grant.vaultId !== this.vaultId ||
      !validIdentifier(grant.profileId) ||
      !this.findExactTab(grant.caller)
    ) {
      throw new Error("Cannot issue a token outside the broker vault or for an unknown tab");
    }
    const crypto = cryptoModule();
    const token = crypto.randomBytes(32).toString("base64url");
    this.callers.push({
      ...grant,
      caller: Object.freeze({ ...grant.caller }),
      capabilities: Object.freeze([...new Set(grant.capabilities)]),
      digest: crypto.createHash("sha256").update(token).digest(),
      requestTimes: [],
      outputRequestTimes: [],
      waitRequestTimes: [],
      messageRequestTimes: [],
      createRequestTimes: [],
      promptRequestTimes: [],
      interruptRequestTimes: [],
      closeRequestTimes: [],
      activeWaits: 0,
    });
    return token;
  }

  getDiagnostics(): readonly BrokerAuditEntry[] {
    return Object.freeze(this.audit.map((entry) => Object.freeze({ ...entry })));
  }

  subscribeMailbox(
    target: TerminalTabTarget,
    listener: (event: BrokerMailboxAvailableEvent) => void,
  ): () => void {
    const key = mailboxKey(target);
    const listeners = this.mailboxListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.mailboxListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.mailboxListeners.delete(key);
    };
  }

  hello(token: string, id: string): BrokerResponse {
    if (!validRequestId(id)) return failure(null, "INVALID_FRAME", "Invalid hello request");
    let caller: StoredCallerGrant | null;
    try {
      caller = this.authenticate(token);
    } catch {
      return failure(id, "INTERNAL", "The broker could not authenticate the request", true);
    }
    if (!caller) {
      const retryAfterMs = consumeRate(this.failedAuthTimes, AUTH_FAILURE_RATE_LIMIT, this.now());
      return retryAfterMs === null
        ? failure(id, "AUTH_FAILED", "The broker token is invalid or stale")
        : failure(id, "RATE_LIMITED", "Authentication attempts are rate limited", true, {
            retryAfterMs,
          });
    }
    const current = new Set(this.getProfileCapabilities(caller.profileId));
    return success(id, {
      brokerEpoch: this.brokerEpoch,
      caller: { ...caller.caller },
      capabilities: caller.capabilities.filter((capability) => current.has(capability)),
    });
  }

  issueLaunchContext(grant: BrokerCallerGrant, endpoint: string): NodeJS.ProcessEnv | undefined {
    if (grant.capabilities.length === 0) return undefined;
    const token = this.issueToken(grant);
    return {
      WORK_TERMINAL_BROKER_PROTOCOL: String(BROKER_PROTOCOL_VERSION),
      WORK_TERMINAL_BROKER_ENDPOINT: endpoint,
      WORK_TERMINAL_TASK_ID: grant.caller.taskId,
      WORK_TERMINAL_TAB_ID: grant.caller.tabId,
      WORK_TERMINAL_TAB_GENERATION: String(grant.caller.generation),
      WORK_TERMINAL_BROKER_TOKEN: token,
    };
  }

  revokeAllCallers(): void {
    this.callers.length = 0;
    this.mailboxes.clear();
    this.deliveryRecords.clear();
    this.acknowledgedRecords.clear();
  }

  async dispatch(
    token: string,
    request: BrokerRequest,
    signal?: AbortSignal,
  ): Promise<BrokerResponse> {
    const startedAt = this.now();
    const id = validRequestId(request?.id) ? request.id : null;
    if (request?.v !== BROKER_PROTOCOL_VERSION) {
      return failure(id, "UNSUPPORTED_VERSION", "Only broker protocol version 1 is supported");
    }
    if (
      !validRequestId(request?.id) ||
      request.type !== "request" ||
      typeof request.method !== "string"
    ) {
      return failure(id, "INVALID_FRAME", "Invalid broker request");
    }
    if (encodedSize(request) > BROKER_FRAME_MAX_BYTES) {
      return failure(id, "LIMIT_EXCEEDED", "The request exceeds the frame limit", false, {
        limit: BROKER_FRAME_MAX_BYTES,
      });
    }

    let caller: StoredCallerGrant | null;
    try {
      caller = this.authenticate(token);
    } catch {
      return failure(id, "INTERNAL", "The broker could not authenticate the request", true);
    }
    if (!caller) {
      const retryAfterMs = consumeRate(this.failedAuthTimes, AUTH_FAILURE_RATE_LIMIT, startedAt);
      return retryAfterMs === null
        ? failure(id, "AUTH_FAILED", "The broker token is invalid or stale")
        : failure(id, "RATE_LIMITED", "Authentication attempts are rate limited", true, {
            retryAfterMs,
          });
    }

    const rateError = this.consumeCallerRate(caller, request.method, startedAt);
    let response: BrokerResponse;
    if (rateError) {
      response = { v: 1, type: "response", id, ok: false, error: rateError };
    } else {
      response = await this.dispatchAuthenticated(caller, request, signal);
    }
    this.recordAudit(caller, request, response, startedAt);
    return response;
  }

  private async dispatchAuthenticated(
    caller: StoredCallerGrant,
    request: BrokerRequest,
    signal?: AbortSignal,
  ): Promise<BrokerResponse> {
    const id = request.id;
    try {
      const required = requiredCapability(request.method);
      const currentCapabilities = new Set(this.getProfileCapabilities(caller.profileId));
      if (!caller.capabilities.includes(required) || !currentCapabilities.has(required)) {
        return failure(id, "CAPABILITY_DENIED", `The caller lacks ${required}`, false, {
          requiredCapability: required,
        });
      }

      const params = request.params ?? {};
      const paramsError = validateParams(request.method, params);
      if (paramsError) return { v: 1, type: "response", id, ok: false, error: paramsError };

      if (request.method === "listCategories") {
        const page = parseListPage(id, params);
        if ("response" in page) return page.response;
        const categories = await this.catalogue.listCategories();
        return paginate(id, categories, page.offset, page.limit, "categories");
      }
      if (request.method === "listTasks") {
        const page = parseListPage(id, params);
        if ("response" in page) return page.response;
        if (params.categoryId !== undefined && !validIdentifier(params.categoryId)) {
          return invalidIdentifier(id, "categoryId");
        }
        const result = await this.catalogue.listTasks({
          categoryId: params.categoryId as string | undefined,
          limit: page.limit,
          ...(params.cursor !== undefined ? { cursor: params.cursor as string } : {}),
        });
        return fitPage(id, result.tasks, page.offset, result.truncated, "tasks");
      }
      if (request.method === "readOutput") return this.readOutput(id, params);
      if (request.method === "waitForTab") return this.waitForTab(caller, id, params, signal);
      if (request.method === "sendMessage") return this.sendMessage(caller, id, params);
      if (request.method === "receiveMessages") return this.receiveMessages(caller, id, params);
      if (request.method === "ackMessages") return this.ackMessages(caller, id, params);
      if (request.method === "promptTab") return this.promptTab(id, params);
      if (request.method === "interruptTab") return this.interruptTab(id, params);
      if (request.method === "closeTab") return this.closeTab(id, params);

      const taskId = params.taskId;
      if (!validIdentifier(taskId)) return invalidIdentifier(id, "taskId");
      const task = await this.catalogue.getTask(taskId);
      if (!task) return failure(id, "NOT_FOUND", "The task was not found");
      if (request.method === "createTab") {
        const tabs = this.collectTabs(taskId);
        if (hasDuplicateTargets(tabs)) {
          return failure(id, "TARGET_UNAVAILABLE", "A tab has multiple host owners", true);
        }
        const pending = this.pendingTabCreations.get(taskId) ?? 0;
        if (tabs.length + pending >= BROKER_TABS_PER_TASK_MAX) {
          return failure(id, "LIMIT_EXCEEDED", "The task has reached its tab limit", false, {
            limit: BROKER_TABS_PER_TASK_MAX,
          });
        }
        const owners = this.findTargetOwners(caller.caller);
        if (owners.length !== 1 || !owners[0].createProfileTab) {
          return failure(id, "TARGET_UNAVAILABLE", "The caller terminal host is unavailable", true);
        }
        this.pendingTabCreations.set(taskId, pending + 1);
        let created: BrokerCreateTabResult;
        try {
          created = await owners[0].createProfileTab(
            taskId,
            params.profileId as string,
            params.initialPrompt as string | undefined,
          );
        } finally {
          const remaining = (this.pendingTabCreations.get(taskId) ?? 1) - 1;
          if (remaining === 0) this.pendingTabCreations.delete(taskId);
          else this.pendingTabCreations.set(taskId, remaining);
        }
        if (created.status === "profile-not-found") {
          return failure(id, "NOT_FOUND", "The profile was not found");
        }
        if (created.status === "invalid-profile") {
          return failure(id, "INVALID_ARGUMENT", "The profile cannot create an agent tab", false, {
            argument: "profileId",
          });
        }
        if (created.status === "unavailable") {
          return failure(id, "TARGET_UNAVAILABLE", "The host could not create the tab", true);
        }
        if (created.tab.taskId !== taskId) {
          return failure(id, "INTERNAL", "The host returned an invalid tab", true);
        }
        this.rememberTab(created.tab);
        return success(id, created.tab);
      }
      if (request.method === "getTask") return success(id, task);
      if (request.method === "listTabs") {
        const page = parseListPage(id, params);
        if ("response" in page) return page.response;
        const tabs = this.collectTabs(taskId);
        if (hasDuplicateTargets(tabs)) {
          return failure(id, "TARGET_UNAVAILABLE", "A tab has multiple host owners", true);
        }
        return paginate(id, tabs, page.offset, page.limit, "tabs");
      }

      const maxDepth = params.maxDepth ?? BROKER_HIERARCHY_DEFAULT_DEPTH;
      const depthError = validateBoundedInteger("maxDepth", maxDepth, BROKER_HIERARCHY_MAX_DEPTH);
      if (depthError) return { v: 1, type: "response", id, ok: false, error: depthError };
      const maxResults = params.maxResults ?? BROKER_HIERARCHY_MAX_RESULTS;
      const resultsError = validateBoundedInteger(
        "maxResults",
        maxResults,
        BROKER_HIERARCHY_MAX_RESULTS,
      );
      if (resultsError) return { v: 1, type: "response", id, ok: false, error: resultsError };
      const options = { maxDepth: maxDepth as number, maxResults: maxResults as number };
      const result =
        request.method === "getSubtasks"
          ? await this.catalogue.getSubtasks(taskId, options)
          : await this.catalogue.getParentTasks(taskId, options);
      return result ? success(id, result) : failure(id, "NOT_FOUND", "The task was not found");
    } catch {
      return failure(id, "INTERNAL", "The broker could not complete the request", true);
    }
  }

  private promptTab(id: string, params: Record<string, unknown>): BrokerResponse {
    const target = parseTarget(params.target);
    if (!target) {
      return failure(id, "INVALID_ARGUMENT", "A valid target is required", false, {
        argument: "target",
      });
    }
    const owners = this.findTargetOwners(target);
    if (owners.length > 1) {
      return failure(id, "TARGET_UNAVAILABLE", "The target has multiple host owners", true);
    }
    if (owners.length === 0) {
      this.pruneKnownTabs();
      const code = this.knownTabs.has(target.tabId) ? "STALE_TARGET" : "NOT_FOUND";
      return failure(
        id,
        code,
        code === "STALE_TARGET" ? "The target is stale" : "The tab was not found",
      );
    }
    if (!owners[0].promptTab) {
      return failure(id, "TARGET_UNAVAILABLE", "The target host is unavailable", true);
    }
    const result = owners[0].promptTab(target, params.prompt as string);
    if (result === null) return failure(id, "STALE_TARGET", "The target became stale");
    if (result === "exited") return failure(id, "TARGET_EXITED", "The target process has exited");
    if (result === "unavailable") {
      return failure(id, "TARGET_UNAVAILABLE", "The target could not accept the prompt", true);
    }
    return success(id, { target, affectedGeneration: target.generation });
  }

  private interruptTab(id: string, params: Record<string, unknown>): BrokerResponse {
    const resolved = this.resolveControlTarget(id, params.target);
    if ("response" in resolved) return resolved.response;
    if (!resolved.host.interruptTab) {
      return failure(id, "TARGET_UNAVAILABLE", "The target host is unavailable", true);
    }
    const result = resolved.host.interruptTab(resolved.target);
    if (result === null) return failure(id, "STALE_TARGET", "The target became stale");
    if (result === "exited") return failure(id, "TARGET_EXITED", "The target process has exited");
    if (result === "unavailable") {
      return failure(id, "TARGET_UNAVAILABLE", "The target could not be interrupted", true);
    }
    return success(id, {
      target: resolved.target,
      affectedGeneration: resolved.target.generation,
    });
  }

  private closeTab(id: string, params: Record<string, unknown>): BrokerResponse {
    const resolved = this.resolveControlTarget(id, params.target);
    if ("response" in resolved) return resolved.response;
    if (!resolved.host.closeTab) {
      return failure(id, "TARGET_UNAVAILABLE", "The target host is unavailable", true);
    }
    const result = resolved.host.closeTab(resolved.target);
    if (result === null) return failure(id, "STALE_TARGET", "The target became stale");
    return success(id, {
      target: resolved.target,
      affectedGeneration: resolved.target.generation,
      processWasRunning: result.processWasRunning,
    });
  }

  private resolveControlTarget(
    id: string,
    value: unknown,
  ): { target: TerminalTabTarget; host: BrokerTerminalHost } | { response: BrokerResponse } {
    const target = parseTarget(value);
    if (!target) {
      return {
        response: failure(id, "INVALID_ARGUMENT", "A valid target is required", false, {
          argument: "target",
        }),
      };
    }
    const owners = this.findTargetOwners(target);
    if (owners.length > 1) {
      return {
        response: failure(id, "TARGET_UNAVAILABLE", "The target has multiple host owners", true),
      };
    }
    if (owners.length === 0) {
      this.pruneKnownTabs();
      const code = this.knownTabs.has(target.tabId) ? "STALE_TARGET" : "NOT_FOUND";
      return {
        response: failure(
          id,
          code,
          code === "STALE_TARGET" ? "The target is stale" : "The tab was not found",
        ),
      };
    }
    return { target, host: owners[0] };
  }

  private readOutput(id: string, params: Record<string, unknown>): BrokerResponse {
    const target = parseTarget(params.target);
    if (!target) {
      return failure(id, "INVALID_ARGUMENT", "A valid target is required", false, {
        argument: "target",
      });
    }
    const maxLines = params.maxLines ?? BROKER_OUTPUT_DEFAULT_LINES;
    const linesError = validateBoundedInteger("maxLines", maxLines, BROKER_OUTPUT_MAX_LINES);
    if (linesError) return { v: 1, type: "response", id, ok: false, error: linesError };
    const maxBytes = params.maxBytes ?? BROKER_OUTPUT_MAX_BYTES;
    const bytesError = validateBoundedInteger("maxBytes", maxBytes, BROKER_OUTPUT_MAX_BYTES);
    if (bytesError) return { v: 1, type: "response", id, ok: false, error: bytesError };

    const owners = this.findTargetOwners(target);
    if (owners.length > 1) {
      return failure(id, "TARGET_UNAVAILABLE", "The target has multiple host owners", true);
    }
    if (owners.length === 0) {
      this.pruneKnownTabs();
      const code = this.knownTabs.has(target.tabId) ? "STALE_TARGET" : "NOT_FOUND";
      return failure(
        id,
        code,
        code === "STALE_TARGET" ? "The target is stale" : "The tab was not found",
      );
    }
    const output = owners[0].readTabOutput(target, {
      maxLines: maxLines as number,
      maxBytes: maxBytes as number,
    });
    return output ? success(id, output) : failure(id, "STALE_TARGET", "The target became stale");
  }

  private waitForTab(
    caller: StoredCallerGrant,
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrokerResponse> | BrokerResponse {
    const target = parseTarget(params.target);
    if (!target) {
      return failure(id, "INVALID_ARGUMENT", "A valid target is required", false, {
        argument: "target",
      });
    }
    const states = parseWaitStates(params.states);
    if (!states)
      return failure(id, "INVALID_ARGUMENT", "states is invalid", false, { argument: "states" });
    const timeoutMs = params.timeoutMs ?? BROKER_WAIT_DEFAULT_TIMEOUT_MS;
    const timeoutError = validateBoundedInteger("timeoutMs", timeoutMs, BROKER_WAIT_MAX_TIMEOUT_MS);
    if (timeoutError) return { v: 1, type: "response", id, ok: false, error: timeoutError };
    if (caller.activeWaits >= CALLER_WAIT_LIMIT) {
      return failure(id, "LIMIT_EXCEEDED", "The caller has too many active waits", false, {
        limit: CALLER_WAIT_LIMIT,
      });
    }
    if (this.activeWaits >= BROKER_WAIT_LIMIT) {
      return failure(id, "LIMIT_EXCEEDED", "The broker has too many active waits", false, {
        limit: BROKER_WAIT_LIMIT,
      });
    }

    const owners = this.findTargetOwners(target);
    if (owners.length > 1) {
      return failure(id, "TARGET_UNAVAILABLE", "The target has multiple host owners", true);
    }
    if (owners.length === 0) return this.missingTargetFailure(id, target);

    const owner = owners[0];
    const initial = owner
      .getTabHostSnapshots(target.taskId)
      .find((snapshot) => sameTarget(snapshot, target));
    if (!initial) return failure(id, "STALE_TARGET", "The target became stale");
    const initialResult = currentWaitResult(id, initial, states);
    if (initialResult) return initialResult;
    if (signal?.aborted) {
      return failure(id, "BROKER_RELOADING", "The broker wait was cancelled", true);
    }

    return new Promise<BrokerResponse>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      caller.activeWaits++;
      this.activeWaits++;

      const complete = (response: BrokerResponse) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        signal?.removeEventListener("abort", onAbort);
        caller.activeWaits--;
        this.activeWaits--;
        resolve(response);
      };
      const onAbort = () =>
        complete(failure(id, "BROKER_RELOADING", "The broker wait was cancelled", true));
      const onEvent = (event: TerminalLifecycleEvent) => {
        if (!sameTarget(event.target, target)) return;
        if (event.type === "closed") {
          complete(failure(id, "STALE_TARGET", "The target became stale"));
        } else if (event.type === "exit") {
          complete(
            success(id, {
              kind: "exit",
              exitCode: event.exitCode,
              signal: event.signal,
              sequence: event.sequence,
            }),
          );
        } else if (event.state === "unknown") {
          complete(success(id, { kind: "unknown", sequence: event.sequence }));
        } else if (states.has(event.state)) {
          complete(success(id, { kind: "state", state: event.state, sequence: event.sequence }));
        }
      };

      unsubscribe = owner.onTabLifecycle(target, onEvent);
      if (!unsubscribe) {
        complete(failure(id, "STALE_TARGET", "The target became stale"));
        return;
      }
      if (settled) {
        unsubscribe();
        return;
      }

      const current = owner
        .getTabHostSnapshots(target.taskId)
        .find((snapshot) => sameTarget(snapshot, target));
      const currentResult = current && currentWaitResult(id, current, states);
      if (!current) {
        complete(failure(id, "STALE_TARGET", "The target became stale"));
      } else if (currentResult) {
        complete(currentResult);
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else
          timer = setTimeout(() => complete(success(id, { kind: "timeout" })), timeoutMs as number);
      }
    });
  }

  private missingTargetFailure(id: string, target: TerminalTabTarget): BrokerResponse {
    this.pruneKnownTabs();
    const code = this.knownTabs.has(target.tabId) ? "STALE_TARGET" : "NOT_FOUND";
    return failure(
      id,
      code,
      code === "STALE_TARGET" ? "The target is stale" : "The tab was not found",
    );
  }

  private sendMessage(
    caller: StoredCallerGrant,
    id: string,
    params: Record<string, unknown>,
  ): BrokerResponse {
    const target = parseTarget(params.target);
    if (!target) {
      return failure(id, "INVALID_ARGUMENT", "A valid target is required", false, {
        argument: "target",
      });
    }
    if (!validIdentifier(params.clientMessageId)) {
      return invalidIdentifier(id, "clientMessageId");
    }
    if (params.kind !== undefined && (typeof params.kind !== "string" || !params.kind)) {
      return failure(id, "INVALID_ARGUMENT", "kind is invalid", false, {
        argument: "kind",
      });
    }
    if (
      typeof params.kind === "string" &&
      Buffer.byteLength(params.kind) > BROKER_MESSAGE_KIND_MAX_BYTES
    ) {
      return failure(id, "LIMIT_EXCEEDED", "kind exceeds its limit", false, {
        argument: "kind",
        limit: BROKER_MESSAGE_KIND_MAX_BYTES,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(params, "payload")) {
      return failure(id, "INVALID_ARGUMENT", "payload is invalid", false, {
        argument: "payload",
      });
    }
    const encodedPayload = encodeJson(params.payload);
    if (!encodedPayload) {
      return failure(id, "INVALID_ARGUMENT", "payload is invalid", false, {
        argument: "payload",
      });
    }
    if (encodedPayload.byteCount > BROKER_MESSAGE_PAYLOAD_MAX_BYTES) {
      return failure(id, "LIMIT_EXCEEDED", "payload exceeds its limit", false, {
        argument: "payload",
        limit: BROKER_MESSAGE_PAYLOAD_MAX_BYTES,
      });
    }

    const owners = this.findTargetOwners(target);
    if (owners.length > 1) {
      return failure(id, "TARGET_UNAVAILABLE", "The target has multiple host owners", true);
    }
    if (owners.length === 0) {
      this.dropMailbox(target);
      this.pruneKnownTabs();
      const code = this.knownTabs.has(target.tabId) ? "STALE_TARGET" : "NOT_FOUND";
      return failure(
        id,
        code,
        code === "STALE_TARGET" ? "The target is stale" : "The tab was not found",
      );
    }

    const recipientCallers = this.callers.filter(
      (candidate) =>
        candidate.caller.tabId === target.tabId &&
        candidate.caller.generation === target.generation,
    );
    if (recipientCallers.length === 0) {
      return failure(id, "TARGET_UNAVAILABLE", "The recipient is not broker-enabled");
    }
    const recipientEnabled = recipientCallers.some(
      (candidate) =>
        candidate.capabilities.includes("message") &&
        this.getProfileCapabilities(candidate.profileId).includes("message"),
    );
    if (!recipientEnabled) {
      return failure(id, "CAPABILITY_DENIED", "The recipient lacks message", false, {
        requiredCapability: "message",
        recipient: true,
      });
    }

    const recipientKey = mailboxKey(target);
    const dedupKey = messageDedupKey(caller.caller, params.clientMessageId);
    this.pruneAcknowledgedRecords(this.now());
    const existing = this.deliveryRecords.get(dedupKey);
    if (existing) return success(id, cloneAcceptance(existing.acceptance));

    const mailbox = this.mailboxes.get(recipientKey) ?? { messages: [], byteCount: 0 };
    if (mailbox.messages.length >= BROKER_MAILBOX_MAX_MESSAGES) {
      return failure(id, "MAILBOX_FULL", "The recipient mailbox is full", false, {
        limit: BROKER_MAILBOX_MAX_MESSAGES,
        resource: "messages",
      });
    }
    const acceptedAt = this.now();
    const messageId = cryptoModule().randomUUID();
    const messageByteCount = encodedSize({
      messageId,
      clientMessageId: params.clientMessageId,
      sender: caller.caller,
      recipient: target,
      acceptedAt,
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      payload: params.payload,
    });
    if (mailbox.byteCount + messageByteCount > BROKER_MAILBOX_MAX_BYTES) {
      return failure(id, "MAILBOX_FULL", "The recipient mailbox is full", false, {
        limit: BROKER_MAILBOX_MAX_BYTES,
        resource: "bytes",
      });
    }
    const acceptance: BrokerMessageAcceptance = Object.freeze({
      messageId,
      acceptedAt,
      target: Object.freeze({ ...target }),
    });
    mailbox.messages.push({
      messageId,
      clientMessageId: params.clientMessageId,
      sender: Object.freeze({ ...caller.caller }),
      recipient: Object.freeze({ ...target }),
      acceptedAt,
      ...(params.kind !== undefined ? { kind: params.kind as string } : {}),
      payloadJson: encodedPayload.json,
      byteCount: messageByteCount,
    });
    mailbox.byteCount += messageByteCount;
    this.mailboxes.set(recipientKey, mailbox);
    this.deliveryRecords.set(dedupKey, { acceptance, recipientKey });
    this.notifyMailbox(recipientKey, mailbox.messages.length);
    return success(id, cloneAcceptance(acceptance));
  }

  private receiveMessages(
    caller: StoredCallerGrant,
    id: string,
    params: Record<string, unknown>,
  ): BrokerResponse {
    const limit = params.limit ?? BROKER_MAILBOX_DEFAULT_LIMIT;
    const limitError = validateBoundedInteger("limit", limit, BROKER_MAILBOX_MAX_LIMIT);
    if (limitError) return { v: 1, type: "response", id, ok: false, error: limitError };
    const mailbox = this.mailboxes.get(mailboxKey(caller.caller));
    const pending = mailbox?.messages.length ?? 0;
    const messages: BrokerMailboxMessage[] = [];
    for (const stored of mailbox?.messages.slice(0, limit as number) ?? []) {
      const message = toMailboxMessage(stored);
      const result = { messages: [...messages, message], pending };
      if (encodedSize(success(id, result)) > BROKER_FRAME_MAX_BYTES) break;
      messages.push(message);
    }
    return success(id, { messages, pending });
  }

  private ackMessages(
    caller: StoredCallerGrant,
    id: string,
    params: Record<string, unknown>,
  ): BrokerResponse {
    if (!Array.isArray(params.messageIds)) {
      return failure(id, "INVALID_ARGUMENT", "messageIds is invalid", false, {
        argument: "messageIds",
      });
    }
    if (params.messageIds.length > BROKER_ACK_MAX_MESSAGES) {
      return failure(id, "LIMIT_EXCEEDED", "messageIds exceeds its limit", false, {
        argument: "messageIds",
        limit: BROKER_ACK_MAX_MESSAGES,
      });
    }
    if (
      params.messageIds.some((messageId) => !validIdentifier(messageId)) ||
      new Set(params.messageIds).size !== params.messageIds.length
    ) {
      return failure(id, "INVALID_ARGUMENT", "messageIds is invalid", false, {
        argument: "messageIds",
      });
    }

    const recipientKey = mailboxKey(caller.caller);
    const mailbox = this.mailboxes.get(recipientKey);
    const acked: string[] = [];
    const alreadyAcked: string[] = [];
    const unknown: string[] = [];
    const now = this.now();
    this.pruneAcknowledgedRecords(now);
    for (const messageId of params.messageIds as string[]) {
      const messageIndex =
        mailbox?.messages.findIndex((message) => message.messageId === messageId) ?? -1;
      if (mailbox && messageIndex >= 0) {
        const [message] = mailbox.messages.splice(messageIndex, 1);
        mailbox.byteCount -= message.byteCount ?? encodedSize(toMailboxMessage(message));
        const dedupKey = messageDedupKey(message.sender, message.clientMessageId);
        const delivery = this.deliveryRecords.get(dedupKey);
        if (delivery) delivery.acknowledgedAt = now;
        this.acknowledgedRecords.set(messageId, { dedupKey, recipientKey, acknowledgedAt: now });
        acked.push(messageId);
      } else if (this.acknowledgedRecords.get(messageId)?.recipientKey === recipientKey) {
        alreadyAcked.push(messageId);
      } else {
        unknown.push(messageId);
      }
    }
    if (mailbox && mailbox.messages.length === 0) this.mailboxes.delete(recipientKey);
    this.pruneAcknowledgedRecords(now);
    return success(id, { acked, alreadyAcked, unknown });
  }

  private dropMailbox(target: TerminalTabTarget): void {
    this.dropMailboxKey(mailboxKey(target));
  }

  private dropMailboxKey(recipientKey: string): void {
    const mailbox = this.mailboxes.get(recipientKey);
    if (!mailbox) return;
    for (const message of mailbox.messages) {
      this.deliveryRecords.delete(messageDedupKey(message.sender, message.clientMessageId));
    }
    this.mailboxes.delete(recipientKey);
  }

  private notifyMailbox(recipientKey: string, pending: number): void {
    const listeners = this.mailboxListeners.get(recipientKey);
    if (!listeners) return;
    this.mailboxEventSequence = incrementDecimal(this.mailboxEventSequence);
    const event = Object.freeze({ sequence: this.mailboxEventSequence, pending });
    for (const listener of [...listeners]) listener(event);
  }

  private pruneAcknowledgedRecords(now: number): void {
    const cutoff = now - ACK_RECORD_TTL_MS;
    for (const [messageId, record] of this.acknowledgedRecords) {
      if (record.acknowledgedAt > cutoff && this.acknowledgedRecords.size <= ACK_RECORD_LIMIT)
        break;
      this.acknowledgedRecords.delete(messageId);
      this.deliveryRecords.delete(record.dedupKey);
    }
  }

  private authenticate(token: string): StoredCallerGrant | null {
    if (typeof token !== "string") return null;
    const crypto = cryptoModule();
    const digest = crypto.createHash("sha256").update(token).digest();
    let caller: StoredCallerGrant | null = null;
    for (const candidate of this.callers) {
      if (
        candidate.digest.length === digest.length &&
        crypto.timingSafeEqual(candidate.digest, digest)
      ) {
        caller = candidate;
      }
    }
    if (!caller) return null;

    const current = this.findTabAcrossHosts(caller.caller.tabId, caller.caller.generation);
    if (!current) return null;
    if (current.taskId !== caller.caller.taskId) {
      caller.caller = Object.freeze(toTarget(current));
    }
    return caller;
  }

  private consumeCallerRate(
    caller: StoredCallerGrant,
    method: string,
    now: number,
  ): BrokerError | null {
    const generalRetry = consumeRate(caller.requestTimes, GENERAL_RATE_LIMIT, now);
    if (generalRetry !== null) return rateError(generalRetry);
    const limits: Partial<Record<string, [number[], number]>> = {
      readOutput: [caller.outputRequestTimes, OUTPUT_RATE_LIMIT],
      waitForTab: [caller.waitRequestTimes, WAIT_RATE_LIMIT],
      sendMessage: [caller.messageRequestTimes, MESSAGE_RATE_LIMIT],
      createTab: [caller.createRequestTimes, CREATE_RATE_LIMIT],
      promptTab: [caller.promptRequestTimes, PROMPT_RATE_LIMIT],
      interruptTab: [caller.interruptRequestTimes, INTERRUPT_RATE_LIMIT],
      closeTab: [caller.closeRequestTimes, CLOSE_RATE_LIMIT],
    };
    const specific = limits[method];
    if (!specific) return null;
    const retryAfterMs = consumeRate(specific[0], specific[1], now);
    return retryAfterMs === null ? null : rateError(retryAfterMs);
  }

  private collectTabs(taskId: string): TerminalTabHostSnapshot[] {
    const tabs = [...this.hosts]
      .flatMap((host) => [...host.getTabHostSnapshots(taskId)])
      .filter((tab) => tab.taskId === taskId);
    for (const tab of tabs) this.rememberTab(tab);
    return tabs;
  }

  private findTargetOwners(target: TerminalTabTarget): BrokerTerminalHost[] {
    const owners: BrokerTerminalHost[] = [];
    for (const host of this.hosts) {
      const tabs = [...host.getTabHostSnapshots(target.taskId)];
      for (const tab of tabs) this.rememberTab(tab);
      if (tabs.some((tab) => sameTarget(tab, target))) owners.push(host);
    }
    return owners;
  }

  private findExactTab(target: TerminalTabTarget): TerminalTabHostSnapshot | null {
    return this.collectTabs(target.taskId).find((tab) => sameTarget(tab, target)) ?? null;
  }

  private findTabAcrossHosts(tabId: string, generation: number): TerminalTabHostSnapshot | null {
    let found: TerminalTabHostSnapshot | null = null;
    for (const host of this.hosts) {
      for (const tab of host.getAllTabHostSnapshots()) {
        this.rememberTab(tab);
        if (tab.tabId === tabId && tab.generation === generation) {
          if (found) return null;
          found = tab;
        }
      }
    }
    return found;
  }

  private rememberTab(tab: TerminalTabHostSnapshot): void {
    this.pruneKnownTabs();
    for (const key of this.mailboxes.keys()) {
      if (key.startsWith(`${tab.tabId}\0`) && key !== mailboxKey(tab)) this.dropMailboxKey(key);
    }
    this.knownTabs.delete(tab.tabId);
    this.knownTabs.set(tab.tabId, { observedAt: this.now() });
    while (this.knownTabs.size > TOMBSTONE_LIMIT) {
      this.knownTabs.delete(this.knownTabs.keys().next().value!);
    }
  }

  private pruneKnownTabs(): void {
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const [tabId, known] of this.knownTabs) {
      if (known.observedAt >= cutoff) break;
      this.knownTabs.delete(tabId);
    }
  }

  private recordAudit(
    caller: StoredCallerGrant,
    request: BrokerRequest,
    response: BrokerResponse,
    startedAt: number,
  ): void {
    const target = parseTarget(request.params?.target);
    const entry: BrokerAuditEntry = Object.freeze({
      timestamp: startedAt,
      brokerEpoch: this.brokerEpoch,
      caller: Object.freeze({ ...caller.caller }),
      ...(target ? { target: Object.freeze(target) } : {}),
      method: request.method,
      allowed: response.ok,
      ...(response.ok === false ? { errorCode: response.error.code } : {}),
      byteCount: auditByteCount(request, response),
      durationMs: Math.max(0, this.now() - startedAt),
    });
    this.audit.push(entry);
    if (this.audit.length > AUDIT_LIMIT) this.audit.splice(0, this.audit.length - AUDIT_LIMIT);
  }
}

function cryptoModule(): typeof import("crypto") {
  return electronRequire("crypto") as typeof import("crypto");
}

function incrementDecimal(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] === "9") {
      digits[index] = "0";
    } else {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join("");
    }
  }
  return `1${digits.join("")}`;
}

function requiredCapability(method: string): BrokerCapability {
  if (method === "readOutput") return "read";
  if (method === "waitForTab") return "wait";
  if (["sendMessage", "receiveMessages", "ackMessages"].includes(method)) return "message";
  if (method === "createTab") return "create-tab";
  if (method === "promptTab") return "prompt-tab";
  if (method === "interruptTab") return "interrupt-tab";
  if (method === "closeTab") return "close-tab";
  return "discover";
}

function mailboxKey(target: TerminalTabTarget): string {
  return `${target.tabId}\0${target.generation}`;
}

function messageDedupKey(sender: TerminalTabTarget, clientMessageId: string): string {
  return `${mailboxKey(sender)}\0${clientMessageId}`;
}

function cloneAcceptance(acceptance: BrokerMessageAcceptance): BrokerMessageAcceptance {
  return { ...acceptance, target: { ...acceptance.target } };
}

function toMailboxMessage(message: StoredMessage): BrokerMailboxMessage {
  return {
    messageId: message.messageId,
    clientMessageId: message.clientMessageId,
    sender: { ...message.sender },
    recipient: { ...message.recipient },
    acceptedAt: message.acceptedAt,
    ...(message.kind !== undefined ? { kind: message.kind } : {}),
    payload: JSON.parse(message.payloadJson) as unknown,
  };
}

function encodeJson(value: unknown): { json: string; byteCount: number } | null {
  try {
    if (!isJsonValue(value, new Set())) return null;
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return { json, byteCount: Buffer.byteLength(json) };
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.getOwnPropertySymbols(value).length === 0 &&
      Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function auditByteCount(request: BrokerRequest, response: BrokerResponse): number {
  if (!response.ok) return 0;
  if (request.method === "readOutput") {
    return Number((response.result as { byteCount?: number }).byteCount ?? 0);
  }
  if (request.method === "sendMessage") return encodeJson(request.params?.payload)?.byteCount ?? 0;
  if (request.method === "receiveMessages") {
    return ((response.result as { messages?: BrokerMailboxMessage[] }).messages ?? []).reduce(
      (total, message) => total + (encodeJson(message.payload)?.byteCount ?? 0),
      0,
    );
  }
  return 0;
}

function sameTarget(a: TerminalTabTarget, b: TerminalTabTarget): boolean {
  return a.taskId === b.taskId && a.tabId === b.tabId && a.generation === b.generation;
}

function toTarget(tab: TerminalTabTarget): TerminalTabTarget {
  return { taskId: tab.taskId, tabId: tab.tabId, generation: tab.generation };
}

function parseListPage(
  id: string,
  params: Record<string, unknown>,
): { limit: number; offset: number } | { response: BrokerResponse } {
  const limit = params.limit ?? BROKER_LIST_DEFAULT_LIMIT;
  const limitError = validateBoundedInteger("limit", limit, BROKER_LIST_MAX_LIMIT);
  if (limitError) return { response: { v: 1, type: "response", id, ok: false, error: limitError } };
  if (params.cursor === undefined) return { limit: limit as number, offset: 0 };
  if (!validIdentifier(params.cursor)) return { response: invalidIdentifier(id, "cursor") };
  const decoded = Buffer.from(params.cursor, "base64url").toString("utf8");
  const offset = Number(decoded);
  if (
    !/^\d+$/.test(decoded) ||
    !Number.isSafeInteger(offset) ||
    Buffer.from(decoded).toString("base64url") !== params.cursor
  ) {
    return {
      response: failure(id, "INVALID_ARGUMENT", "cursor is invalid", false, {
        argument: "cursor",
      }),
    };
  }
  return { limit: limit as number, offset };
}

function paginate<T>(
  id: string,
  values: readonly T[],
  offset: number,
  limit: number,
  key: "categories" | "tabs",
): BrokerResponse {
  const items = values.slice(offset, offset + limit);
  return fitPage(id, items, offset, offset + items.length < values.length, key);
}

function fitPage<T>(
  id: string,
  values: readonly T[],
  offset: number,
  hasMore: boolean,
  key: "categories" | "tasks" | "tabs",
): BrokerResponse {
  const items = [...values];
  let truncated = hasMore;
  const buildResponse = () =>
    success(id, {
      [key]: items,
      truncated,
      ...(truncated
        ? { nextCursor: Buffer.from(String(offset + items.length)).toString("base64url") }
        : {}),
    });
  let response = buildResponse();
  while (items.length > 0 && encodedSize(response) > BROKER_FRAME_MAX_BYTES) {
    items.pop();
    truncated = true;
    response = buildResponse();
  }
  return items.length > 0 || values.length === 0
    ? response
    : failure(id, "LIMIT_EXCEEDED", "A list item exceeds the frame limit", false, {
        limit: BROKER_FRAME_MAX_BYTES,
      });
}

function parseTarget(value: unknown): TerminalTabTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (
    !validIdentifier(target.taskId) ||
    !validIdentifier(target.tabId) ||
    !Number.isSafeInteger(target.generation) ||
    (target.generation as number) < 1
  ) {
    return null;
  }
  return {
    taskId: target.taskId as string,
    tabId: target.tabId as string,
    generation: target.generation as number,
  };
}

function validateParams(method: string, params: unknown): BrokerError | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return invalidArgumentError("params");
  }
  const allowed: Record<string, readonly string[]> = {
    listCategories: ["limit", "cursor"],
    listTasks: ["categoryId", "limit", "cursor"],
    getTask: ["taskId"],
    listTabs: ["taskId", "limit", "cursor"],
    getSubtasks: ["taskId", "maxDepth", "maxResults"],
    getParentTasks: ["taskId", "maxDepth", "maxResults"],
    readOutput: ["target", "maxLines", "maxBytes"],
    waitForTab: ["target", "states", "timeoutMs"],
    sendMessage: ["target", "clientMessageId", "kind", "payload"],
    receiveMessages: ["limit"],
    ackMessages: ["messageIds"],
    createTab: ["taskId", "profileId", "initialPrompt"],
    promptTab: ["target", "prompt"],
    interruptTab: ["target"],
    closeTab: ["target"],
  };
  if (!Object.prototype.hasOwnProperty.call(allowed, method)) return invalidArgumentError("method");
  const unexpected = Object.keys(params).find((key) => !allowed[method].includes(key));
  if (unexpected) return invalidArgumentError(unexpected);
  if (method === "createTab") {
    if (!validIdentifier((params as Record<string, unknown>).profileId)) {
      return invalidArgumentError("profileId");
    }
    const initialPrompt = (params as Record<string, unknown>).initialPrompt;
    if (initialPrompt !== undefined) return validatePrompt("initialPrompt", initialPrompt);
  }
  if (method === "promptTab") {
    return validatePrompt("prompt", (params as Record<string, unknown>).prompt);
  }
  return null;
}

function validatePrompt(argument: string, value: unknown): BrokerError | null {
  if (typeof value !== "string" || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    return invalidArgumentError(argument);
  }
  if (Buffer.byteLength(value) > BROKER_PROMPT_MAX_BYTES) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `${argument} exceeds its limit`,
      retryable: false,
      details: { argument, limit: BROKER_PROMPT_MAX_BYTES },
    };
  }
  return null;
}

function currentWaitResult(
  id: string,
  snapshot: TerminalTabHostSnapshot,
  states: ReadonlySet<Exclude<TerminalHostRuntimeState, "unknown">>,
): BrokerResponse | null {
  if (snapshot.processStatus === "exited") {
    return success(id, {
      kind: "exit",
      exitCode: null,
      signal: null,
      sequence: snapshot.latestSequence,
    });
  }
  if (snapshot.state === "unknown") {
    return success(id, { kind: "unknown", sequence: snapshot.latestSequence });
  }
  return states.has(snapshot.state)
    ? success(id, { kind: "state", state: snapshot.state, sequence: snapshot.latestSequence })
    : null;
}

function parseWaitStates(value: unknown): Set<Exclude<TerminalHostRuntimeState, "unknown">> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const allowed = new Set(["active", "idle", "waiting"]);
  if (value.some((state) => typeof state !== "string" || !allowed.has(state))) return null;
  return new Set(value as Array<Exclude<TerminalHostRuntimeState, "unknown">>);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= BROKER_IDENTIFIER_MAX_BYTES
  );
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]{1,64}$/.test(value);
}

function validateBoundedInteger(
  argument: string,
  value: unknown,
  limit: number,
): BrokerError | null {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalidArgumentError(argument);
  if ((value as number) > limit) {
    return {
      code: "LIMIT_EXCEEDED",
      message: `${argument} exceeds its limit`,
      retryable: false,
      details: { argument, limit },
    };
  }
  return null;
}

function invalidArgumentError(argument: string): BrokerError {
  return {
    code: "INVALID_ARGUMENT",
    message: `${argument} is invalid`,
    retryable: false,
    details: { argument },
  };
}

function invalidIdentifier(id: string, argument: string): BrokerResponse {
  return failure(id, "INVALID_ARGUMENT", `${argument} is invalid`, false, {
    argument,
    limit: BROKER_IDENTIFIER_MAX_BYTES,
  });
}

function hasDuplicateTargets(tabs: readonly TerminalTabTarget[]): boolean {
  const seen = new Set<string>();
  for (const tab of tabs) {
    const key = `${tab.taskId}\0${tab.tabId}\0${tab.generation}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function consumeRate(times: number[], limit: number, now: number): number | null {
  while (times.length > 0 && times[0] <= now - RATE_WINDOW_MS) times.shift();
  if (times.length >= limit) return Math.max(1, times[0] + RATE_WINDOW_MS - now);
  times.push(now);
  return null;
}

function rateError(retryAfterMs: number): BrokerError {
  return {
    code: "RATE_LIMITED",
    message: "The caller request rate was exceeded",
    retryable: true,
    details: { retryAfterMs },
  };
}

function encodedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function success(id: string | null, result: unknown): BrokerResponse {
  return { v: 1, type: "response", id, ok: true, result };
}

function failure(
  id: string | null,
  code: BrokerError["code"],
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): BrokerResponse {
  return {
    v: 1,
    type: "response",
    id,
    ok: false,
    error: { code, message, retryable, ...(details ? { details } : {}) },
  };
}
