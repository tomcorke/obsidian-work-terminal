import { electronRequire } from "../utils";
import {
  BROKER_FRAME_MAX_BYTES,
  BROKER_PROTOCOL_VERSION,
  type BrokerMailboxAvailableEvent,
  type BrokerRequest,
  type BrokerResponse,
  TaskTabBroker,
} from "./TaskTabBroker";

const MAX_CONNECTIONS = 128;
const MAX_CALLER_CONNECTIONS = 4;
const MAX_IN_FLIGHT = 32;

type Net = typeof import("net");
type Socket = import("net").Socket;
type Server = import("net").Server;

interface ConnectionState {
  socket: Socket;
  buffer: Buffer;
  token?: string;
  callerKey?: string;
  inFlight: Map<string, AbortController>;
  mailboxUnsubscribe?: () => void;
  pendingMailboxEvent?: BrokerMailboxAvailableEvent;
  closing: boolean;
}

export function createBrokerEndpoint(vaultId: string): string {
  const crypto = electronRequire("crypto") as typeof import("crypto");
  const os = electronRequire("os") as typeof import("os");
  const path = electronRequire("path") as typeof import("path");
  const digest = crypto
    .createHash("sha256")
    .update(`${vaultId}\0${process.pid}`)
    .digest("hex")
    .slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\work-terminal-${digest}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `work-terminal-${uid}`, `${digest}.sock`);
}

export class TaskTabBrokerTransport {
  private server: Server | null = null;
  private readonly connections = new Set<ConnectionState>();
  private readonly callerConnections = new Map<string, number>();

  constructor(
    private readonly broker: TaskTabBroker,
    readonly endpoint: string,
  ) {}

  get isListening(): boolean {
    return this.server?.listening === true;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const net = electronRequire("net") as Net;
    if (process.platform !== "win32") this.prepareUnixEndpoint();
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.endpoint);
      });
      if (process.platform !== "win32") {
        const fs = electronRequire("fs") as typeof import("fs");
        fs.chmodSync(this.endpoint, 0o600);
      }
    } catch (error) {
      this.server = null;
      this.removeUnixEndpoint();
      throw error;
    }
  }

  async stop(options: { reloading?: boolean } = {}): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const connection of this.connections) {
      connection.closing = true;
      if (options.reloading) {
        for (const id of connection.inFlight.keys()) {
          this.write(
            connection.socket,
            transportFailure(id, "BROKER_RELOADING", "The broker is reloading"),
          );
        }
      }
      for (const controller of connection.inFlight.values()) controller.abort();
      connection.mailboxUnsubscribe?.();
      connection.mailboxUnsubscribe = undefined;
      if (options.reloading) {
        connection.socket.end(
          `${JSON.stringify({
            v: 1,
            type: "event",
            event: "broker.reloading",
            sequence: "0",
            data: {},
          })}\n`,
          () => connection.socket.destroy(),
        );
      } else {
        connection.socket.destroy();
      }
    }
    this.connections.clear();
    this.callerConnections.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.removeUnixEndpoint();
  }

  private prepareUnixEndpoint(): void {
    const fs = electronRequire("fs") as typeof import("fs");
    const path = electronRequire("path") as typeof import("path");
    fs.mkdirSync(path.dirname(this.endpoint), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this.endpoint), 0o700);
    try {
      const stat = fs.lstatSync(this.endpoint);
      if (!stat.isSocket()) throw new Error("Refusing to replace a non-socket broker endpoint");
      fs.unlinkSync(this.endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private removeUnixEndpoint(): void {
    if (process.platform === "win32") return;
    const fs = electronRequire("fs") as typeof import("fs");
    try {
      if (fs.lstatSync(this.endpoint).isSocket()) fs.unlinkSync(this.endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private accept(socket: Socket): void {
    if (this.connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const state: ConnectionState = {
      socket,
      buffer: Buffer.alloc(0),
      inFlight: new Map(),
      closing: false,
    };
    this.connections.add(state);
    socket.on("data", (chunk: Buffer) => this.onData(state, chunk));
    socket.on("error", () => this.close(state));
    socket.on("close", () => this.close(state));
  }

  private onData(state: ConnectionState, chunk: Buffer): void {
    if (state.closing) return;
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (!state.closing) {
      const newline = state.buffer.indexOf(0x0a);
      if (newline === -1) {
        if (state.buffer.length > BROKER_FRAME_MAX_BYTES) {
          this.failAndClose(state, "LIMIT_EXCEEDED", "The frame exceeds its limit", {
            limit: BROKER_FRAME_MAX_BYTES,
          });
        }
        return;
      }
      if (newline > BROKER_FRAME_MAX_BYTES) {
        this.failAndClose(state, "LIMIT_EXCEEDED", "The frame exceeds its limit", {
          limit: BROKER_FRAME_MAX_BYTES,
        });
        return;
      }
      const frame = state.buffer.subarray(0, newline);
      state.buffer = state.buffer.subarray(newline + 1);
      this.handleFrame(state, frame);
    }
  }

  private handleFrame(state: ConnectionState, frame: Buffer): void {
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      if (!text) throw new Error("blank frame");
      value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    } catch {
      this.failAndClose(state, "INVALID_FRAME", "The frame is not a valid JSON object");
      return;
    }

    const envelope = value as Record<string, unknown>;
    if (envelope.v !== BROKER_PROTOCOL_VERSION) {
      this.failAndClose(
        state,
        "UNSUPPORTED_VERSION",
        "Only broker protocol version 1 is supported",
      );
      return;
    }
    if (!state.token) {
      if (envelope.type === "request") {
        this.failAndClose(state, "AUTH_REQUIRED", "Authenticate with hello before requesting");
      } else {
        this.handleHello(state, envelope);
      }
      return;
    }
    if (envelope.type !== "request") {
      this.failAndClose(state, "INVALID_FRAME", "Expected a broker request");
      return;
    }
    const id = envelope.id;
    if (typeof id !== "string" || state.inFlight.has(id)) {
      this.failAndClose(state, "INVALID_FRAME", "The request ID is invalid or already in flight");
      return;
    }
    if (state.inFlight.size >= MAX_IN_FLIGHT) {
      this.write(
        state.socket,
        transportFailure(id, "LIMIT_EXCEEDED", "Too many requests in flight", {
          limit: MAX_IN_FLIGHT,
        }),
      );
      return;
    }

    const controller = new AbortController();
    state.inFlight.set(id, controller);
    void this.broker
      .dispatch(state.token, envelope as unknown as BrokerRequest, controller.signal)
      .then((response) => {
        if (!state.closing) this.writeBoundedResponse(state, response);
      })
      .catch(() => {
        if (!state.closing) {
          this.writeBoundedResponse(
            state,
            transportFailure(id, "INTERNAL", "The broker could not complete the request"),
          );
        }
      })
      .finally(() => {
        state.inFlight.delete(id);
        this.flushMailboxEvent(state);
      });
  }

  private handleHello(state: ConnectionState, envelope: Record<string, unknown>): void {
    const keys = Object.keys(envelope).sort().join(",");
    if (
      envelope.type !== "hello" ||
      keys !== "id,token,type,v" ||
      typeof envelope.id !== "string" ||
      typeof envelope.token !== "string"
    ) {
      this.failAndClose(state, "INVALID_FRAME", "The first frame must be hello");
      return;
    }
    const response = this.broker.hello(envelope.token, envelope.id);
    if (!response.ok) {
      this.write(state.socket, response);
      state.closing = true;
      state.socket.end();
      return;
    }
    const helloResult = response.result as {
      caller: { taskId: string; tabId: string; generation: number };
      capabilities: string[];
    };
    const caller = helloResult.caller;
    const callerKey = `${caller.tabId}\0${caller.generation}`;
    const count = this.callerConnections.get(callerKey) ?? 0;
    if (count >= MAX_CALLER_CONNECTIONS) {
      this.write(
        state.socket,
        transportFailure(envelope.id, "LIMIT_EXCEEDED", "Too many caller connections", {
          limit: MAX_CALLER_CONNECTIONS,
        }),
      );
      state.closing = true;
      state.socket.end();
      return;
    }
    state.token = envelope.token;
    state.callerKey = callerKey;
    if (helloResult.capabilities.includes("message")) {
      state.mailboxUnsubscribe = this.broker.subscribeMailbox(caller, (event) => {
        if (state.closing) return;
        if (state.inFlight.size > 0) state.pendingMailboxEvent = event;
        else this.writeMailboxEvent(state, event);
      });
    }
    this.callerConnections.set(callerKey, count + 1);
    this.write(state.socket, response);
  }

  private flushMailboxEvent(state: ConnectionState): void {
    if (state.closing || state.inFlight.size > 0 || !state.pendingMailboxEvent) return;
    const event = state.pendingMailboxEvent;
    state.pendingMailboxEvent = undefined;
    this.writeMailboxEvent(state, event);
  }

  private writeMailboxEvent(state: ConnectionState, event: BrokerMailboxAvailableEvent): void {
    this.write(state.socket, {
      v: 1,
      type: "event",
      event: "mailbox.available",
      sequence: event.sequence,
      data: { pending: event.pending },
    });
  }

  private writeBoundedResponse(state: ConnectionState, response: BrokerResponse): void {
    const encoded = Buffer.from(`${JSON.stringify(response)}\n`);
    if (encoded.length - 1 <= BROKER_FRAME_MAX_BYTES) {
      state.socket.write(encoded);
      return;
    }
    this.write(
      state.socket,
      transportFailure(response.id, "LIMIT_EXCEEDED", "The response exceeds the frame limit", {
        limit: BROKER_FRAME_MAX_BYTES,
      }),
    );
  }

  private write(socket: Socket, value: unknown): void {
    socket.write(`${JSON.stringify(value)}\n`);
  }

  private failAndClose(
    state: ConnectionState,
    code: "INVALID_FRAME" | "UNSUPPORTED_VERSION" | "AUTH_REQUIRED" | "LIMIT_EXCEEDED",
    message: string,
    details?: Record<string, unknown>,
  ): void {
    state.closing = true;
    this.write(state.socket, transportFailure(null, code, message, details));
    state.socket.end();
  }

  private close(state: ConnectionState): void {
    if (!this.connections.delete(state)) return;
    state.closing = true;
    for (const controller of state.inFlight.values()) controller.abort();
    state.inFlight.clear();
    state.mailboxUnsubscribe?.();
    if (state.callerKey) {
      const count = (this.callerConnections.get(state.callerKey) ?? 1) - 1;
      if (count > 0) this.callerConnections.set(state.callerKey, count);
      else this.callerConnections.delete(state.callerKey);
    }
  }
}

function transportFailure(
  id: string | null,
  code:
    | "INVALID_FRAME"
    | "UNSUPPORTED_VERSION"
    | "AUTH_REQUIRED"
    | "LIMIT_EXCEEDED"
    | "BROKER_RELOADING"
    | "INTERNAL",
  message: string,
  details?: Record<string, unknown>,
): BrokerResponse {
  return {
    v: 1,
    type: "response",
    id,
    ok: false,
    error: {
      code,
      message,
      retryable: code === "INTERNAL" || code === "BROKER_RELOADING",
      ...(details ? { details } : {}),
    },
  };
}
