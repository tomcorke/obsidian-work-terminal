import type { BrokerCapability } from "../agents/AgentProfile";
import type {
  CleanOutputRead,
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
export const BROKER_PROMPT_MAX_BYTES = 16 * 1024;
export const BROKER_TABS_PER_TASK_MAX = 32;

const RATE_WINDOW_MS = 60_000;
const GENERAL_RATE_LIMIT = 120;
const OUTPUT_RATE_LIMIT = 60;
const CREATE_RATE_LIMIT = 6;
const PROMPT_RATE_LIMIT = 20;
const AUTH_FAILURE_RATE_LIMIT = 20;
const TOMBSTONE_TTL_MS = 60 * 60_000;
const TOMBSTONE_LIMIT = 10_000;
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
  | "createTab"
  | "promptTab";

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
  listTasks(options?: { categoryId?: string; limit?: number }): Promise<TaskListResult>;
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
  createProfileTab?(
    taskId: string,
    profileId: string,
    initialPrompt?: string,
  ): Promise<BrokerCreateTabResult>;
  promptTab?(
    target: TerminalTabTarget,
    prompt: string,
  ): "accepted" | "exited" | "unavailable" | null;
}

export interface BrokerCallerGrant {
  vaultId: string;
  caller: TerminalTabTarget;
  profileId: string;
  capabilities: readonly BrokerCapability[];
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
  createRequestTimes: number[];
  promptRequestTimes: number[];
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
    createRequestTimes?: number[];
    promptRequestTimes?: number[];
  }>;
  knownTabs: Array<[string, KnownTab]>;
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
  private readonly failedAuthTimes: number[] = [];
  private readonly audit: BrokerAuditEntry[] = [];

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
          createRequestTimes: [...(caller.createRequestTimes ?? [])],
          promptRequestTimes: [...(caller.promptRequestTimes ?? [])],
        });
      }
      for (const [tabId, known] of runtime.knownTabs) {
        this.knownTabs.set(tabId, { ...known });
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
        createRequestTimes: [...caller.createRequestTimes],
        promptRequestTimes: [...caller.promptRequestTimes],
      })),
      knownTabs: [...this.knownTabs].map(([tabId, known]) => [tabId, { ...known }]),
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
      createRequestTimes: [],
      promptRequestTimes: [],
    });
    return token;
  }

  getDiagnostics(): readonly BrokerAuditEntry[] {
    return Object.freeze(this.audit.map((entry) => Object.freeze({ ...entry })));
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
  }

  async dispatch(token: string, request: BrokerRequest): Promise<BrokerResponse> {
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
      response = await this.dispatchAuthenticated(caller, request);
    }
    this.recordAudit(caller, request, response, startedAt);
    return response;
  }

  private async dispatchAuthenticated(
    caller: StoredCallerGrant,
    request: BrokerRequest,
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
        const categories = await this.catalogue.listCategories();
        return categories.length <= BROKER_LIST_MAX_LIMIT
          ? success(id, categories)
          : failure(id, "LIMIT_EXCEEDED", "The category result exceeds its limit", false, {
              limit: BROKER_LIST_MAX_LIMIT,
            });
      }
      if (request.method === "listTasks") {
        const limit = params.limit ?? BROKER_LIST_DEFAULT_LIMIT;
        const limitError = validateBoundedInteger("limit", limit, BROKER_LIST_MAX_LIMIT);
        if (limitError) return { v: 1, type: "response", id, ok: false, error: limitError };
        if (params.categoryId !== undefined && !validIdentifier(params.categoryId)) {
          return invalidIdentifier(id, "categoryId");
        }
        return success(
          id,
          await this.catalogue.listTasks({
            categoryId: params.categoryId as string | undefined,
            limit: limit as number,
          }),
        );
      }
      if (request.method === "readOutput") return this.readOutput(id, params);
      if (request.method === "promptTab") return this.promptTab(id, params);

      const taskId = params.taskId;
      if (!validIdentifier(taskId)) return invalidIdentifier(id, "taskId");
      const task = await this.catalogue.getTask(taskId);
      if (!task) return failure(id, "NOT_FOUND", "The task was not found");
      if (request.method === "createTab") {
        const tabs = this.collectTabs(taskId);
        if (hasDuplicateTargets(tabs)) {
          return failure(id, "TARGET_UNAVAILABLE", "A tab has multiple host owners", true);
        }
        if (tabs.length >= BROKER_TABS_PER_TASK_MAX) {
          return failure(id, "LIMIT_EXCEEDED", "The task has reached its tab limit", false, {
            limit: BROKER_TABS_PER_TASK_MAX,
          });
        }
        const owners = this.findTargetOwners(caller.caller);
        if (owners.length !== 1 || !owners[0].createProfileTab) {
          return failure(id, "TARGET_UNAVAILABLE", "The caller terminal host is unavailable", true);
        }
        const created = await owners[0].createProfileTab(
          taskId,
          params.profileId as string,
          params.initialPrompt as string | undefined,
        );
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
        const tabs = this.collectTabs(taskId);
        if (hasDuplicateTargets(tabs)) {
          return failure(id, "TARGET_UNAVAILABLE", "A tab has multiple host owners", true);
        }
        return tabs.length <= BROKER_LIST_MAX_LIMIT
          ? success(id, tabs)
          : failure(id, "LIMIT_EXCEEDED", "The tab result exceeds its limit", false, {
              limit: BROKER_LIST_MAX_LIMIT,
            });
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
      createTab: [caller.createRequestTimes, CREATE_RATE_LIMIT],
      promptTab: [caller.promptRequestTimes, PROMPT_RATE_LIMIT],
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
      ...(!response.ok ? { errorCode: response.error.code } : {}),
      byteCount:
        response.ok && request.method === "readOutput"
          ? Number((response.result as { byteCount?: number }).byteCount ?? 0)
          : 0,
      durationMs: Math.max(0, this.now() - startedAt),
    });
    this.audit.push(entry);
    if (this.audit.length > AUDIT_LIMIT) this.audit.splice(0, this.audit.length - AUDIT_LIMIT);
  }
}

function cryptoModule(): typeof import("crypto") {
  return electronRequire("crypto") as typeof import("crypto");
}

function sameTarget(a: TerminalTabTarget, b: TerminalTabTarget): boolean {
  return a.taskId === b.taskId && a.tabId === b.tabId && a.generation === b.generation;
}

function toTarget(tab: TerminalTabTarget): TerminalTabTarget {
  return { taskId: tab.taskId, tabId: tab.tabId, generation: tab.generation };
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
    listCategories: [],
    listTasks: ["categoryId", "limit"],
    getTask: ["taskId"],
    listTabs: ["taskId"],
    getSubtasks: ["taskId", "maxDepth", "maxResults"],
    getParentTasks: ["taskId", "maxDepth", "maxResults"],
    readOutput: ["target", "maxLines", "maxBytes"],
    createTab: ["taskId", "profileId", "initialPrompt"],
    promptTab: ["target", "prompt"],
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

function requiredCapability(method: string): BrokerCapability {
  if (method === "readOutput") return "read";
  if (method === "createTab") return "create-tab";
  if (method === "promptTab") return "prompt-tab";
  return "discover";
}

function validatePrompt(argument: string, value: unknown): BrokerError | null {
  if (typeof value !== "string") return invalidArgumentError(argument);
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
