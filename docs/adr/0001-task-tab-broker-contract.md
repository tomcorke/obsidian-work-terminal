# ADR 0001: Task Tab Broker contract

- **Status:** Accepted
- **Date:** 2026-10-08
- **Issue:** [#585](https://github.com/tomcorke/obsidian-work-terminal/issues/585)

## Context

Agent sessions currently control only their own terminal input. Cross-task discovery, lifecycle waits, messaging, and remote tab operations need one public boundary that does not expose xterm, DOM, child-process, workspace, or reload-store internals.

The boundary must remain vault-scoped, opt-in, capability-controlled, safe across plugin hot reload, and testable through requests and responses rather than renderer implementation details.

## Decision

### Ownership and scope

A single plugin-owned `TaskTabBroker` is the authority for one open vault. It owns:

- the local IPC listener and authenticated connections;
- caller identities, capability grants, limits, runtime audit metadata, waits, and mailboxes;
- the vault task catalogue exposed by adapter/framework APIs; and
- a registry of terminal hosts contributed by every live Work Terminal view.

`TerminalTab`, `TabManager`, and `TerminalPanelView` continue to own terminals, processes, and UI. They expose narrow host primitives to the broker. The broker never exports references to those objects. Adapters remain authoritative for category and task relationships; the helper does not parse vault files.

The contract covers only the current vault and Work Terminal tabs. It does not provide arbitrary terminal input, shell execution, task mutation, filesystem access, workspace automation, or cross-vault access.

### Stable identity and generations

- Task IDs are adapter-issued stable work-item IDs.
- Tab IDs are random UUIDs, stable for one logical terminal tab and retained when its live PTY is rewrapped during hot reload.
- Every tab has a positive safe-integer `generation`. A fresh tab starts at `1`. Replacing a tab while retaining its ID increments the generation. Preserving the same live tab and PTY through hot reload does not.
- Moving a live tab to another task preserves its tab ID and generation, updates its server-owned caller task binding, and makes targets containing the old task ID stale. Injected task environment is launch context; the caller returned by hello is authoritative after a move or reconnect.
- All tab-targeted methods except `listTabs` require the full `{ taskId, tabId, generation }` target returned by the broker. Labels and array indices are never targets.
- A request whose tab ID is known but whose generation is closed, replaced, or different returns `STALE_TARGET`. An ID never observed by the current broker runtime, or whose bounded tombstone has expired, returns `NOT_FOUND`.
- The broker retains closed/replaced target tombstones for one hour, capped at 10,000 entries. Oldest tombstones are discarded first.
- Mutating success results include `affectedGeneration`. A result for one generation says nothing about a later generation using the same tab ID.

Tab events carry a broker-assigned monotonically increasing `sequence` scoped to `{ brokerEpoch, taskId, tabId, generation }`. Sequence values are decimal strings so clients do not lose integer precision. They order observations; clients cannot submit them.

### Local transport and framing

The transport uses Node's built-in `net` module: a Unix-domain socket on macOS/Linux and a named pipe on Windows. There is no network listener and no new dependency. The endpoint is created in a user-private runtime location; Unix permissions are `0600`. Token authentication remains mandatory on every platform.

The protocol is UTF-8 newline-delimited JSON. Each line is exactly one frame and must decode to a JSON object. Blank lines, binary frames, compression, batch arrays, and JSON values after the first complete value are invalid. A frame is limited to 65,536 bytes before the newline.

Every frame contains integer `v: 1`. The first client frame must be:

```json
{ "v": 1, "type": "hello", "id": "h1", "token": "<capability token>" }
```

A successful hello response binds the connection to the server-owned caller identity:

```json
{
  "v": 1,
  "type": "response",
  "id": "h1",
  "ok": true,
  "result": {
    "brokerEpoch": "<uuid>",
    "caller": { "taskId": "<id>", "tabId": "<uuid>", "generation": 1 },
    "capabilities": ["discover"]
  }
}
```

Later requests omit identity and credentials:

```json
{ "v": 1, "type": "request", "id": "r1", "method": "listTabs", "params": { "taskId": "<id>" } }
```

Each request receives exactly one response with the same ID:

```json
{ "v": 1, "type": "response", "id": "r1", "ok": true, "result": {} }
```

Server events use:

```json
{
  "v": 1,
  "type": "event",
  "event": "mailbox.available",
  "sequence": "42",
  "data": { "pending": 1 }
}
```

Version 1 emits only `mailbox.available` as a delivery hint and `broker.reloading` before a planned reload. Lifecycle transitions remain host-internal and complete `waitForTab` responses; there is no general event subscription API. Events may be missed and never replace a state read, a wait result, or a mailbox read.

Request IDs are 1-64 printable ASCII characters, unique among requests currently in flight on that connection. The server may emit one parse/protocol error with `id: null` when an ID cannot be recovered, then closes the connection. An unsupported version returns `UNSUPPORTED_VERSION` and closes the connection. Version 1 is changed only compatibly; incompatible fields or semantics require a new integer version and handshake. Responses and events obey the same frame limit. Paginated methods stop before that limit and return a `nextCursor`; non-paginated results that cannot fit return `LIMIT_EXCEEDED`.

### Caller authentication

Broker access is off by default. An enabled agent profile launches each opted-in session with:

- `WORK_TERMINAL_BROKER_PROTOCOL=1`
- `WORK_TERMINAL_BROKER_ENDPOINT`
- `WORK_TERMINAL_TASK_ID`
- `WORK_TERMINAL_TAB_ID`
- `WORK_TERMINAL_TAB_GENERATION`
- `WORK_TERMINAL_BROKER_TOKEN`

The token contains 32 cryptographically random bytes encoded as base64url. The broker stores a SHA-256 token digest associated with the caller context and uses constant-time digest comparison. It binds the connection to vault, task, tab, generation, profile, and the profile's capability snapshot. No request may override caller identity or grants.

Tokens expire synchronously when the caller tab closes or its generation changes. Disabling the broker expires all tokens. Removing a capability from a profile immediately revokes it from live callers; adding a capability does not elevate existing tokens and requires a new session. Tokens survive plugin hot reload only while the same live tab generation survives. They are never persisted to disk, returned after hello, included in diagnostics, or logged. Endpoint paths are also omitted from ordinary logs.

The socket and token are a local capability boundary, not a sandbox against a hostile process running as the same OS user that can inspect another process's environment or memory.

### Capability matrix

Capabilities do not imply one another. Knowing an ID does not bypass a grant. Each operation may target any task in the authenticated vault unless stated otherwise.

| Capability      | Methods                                                                               | Authority                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`      | `listCategories`, `listTasks`, `getTask`, `getSubtasks`, `getParentTasks`, `listTabs` | Read bounded task/category/tab summaries.                                                                                                                |
| `read`          | `readOutput`                                                                          | Read clean bounded output for an exact live tab generation.                                                                                              |
| `wait`          | `waitForTab`                                                                          | Observe current/future state or process exit for an exact generation.                                                                                    |
| `message`       | `sendMessage`, `receiveMessages`, `ackMessages`                                       | Send to an exact broker-enabled generation; receive/ack only the authenticated caller's mailbox. Both sender and recipient profiles must have `message`. |
| `create-tab`    | `createTab`                                                                           | Create a profile-backed agent tab for a task with an optional initial prompt.                                                                            |
| `prompt-tab`    | `promptTab`                                                                           | Submit one bounded prompt through the host prompt primitive. Not arbitrary key input.                                                                    |
| `interrupt-tab` | `interruptTab`                                                                        | Request interruption through the host process primitive.                                                                                                 |
| `close-tab`     | `closeTab`                                                                            | Close the exact generation, including a running process. Destructive and disabled by default.                                                            |

Discovery is read-only but still opt-in. All mutation capabilities are disabled by default and granted per profile. A caller may use a mutating capability with a known exact target without also receiving `discover`, `read`, or `wait`.

`receiveMessages` and `ackMessages` cannot name another mailbox. `sendMessage` is rejected when the recipient generation is not broker-enabled with `message`.

### Operation results

Task summaries contain only stable ID, title, category/state, adapter-safe path/reference, and direct parent/child IDs. Recursive relationship entries also contain `depth` and whether the relationship is direct. Results are cycle-safe, deduplicated, deterministically ordered, and report `missingIds`, `cycles`, and `truncated`; incompleteness is never silent.

Tab summaries contain `taskId`, `tabId`, `generation`, label, session type/profile ID where non-sensitive, runtime state, process status, and latest event sequence. Broker runtime state is `active`, `idle`, `waiting`, or `unknown`; a shell, unsupported agent, absent detector, or indeterminate detector is `unknown`. Process status is reported separately as `running` or `exited`. Summaries do not contain terminal, process, DOM, environment, token, command-line, or reload-store data.

`readOutput` reads the host-maintained clean-output ring, never xterm private fields, and does not move the viewport. Its result reports returned line/byte counts and whether older output was truncated.

`waitForTab` pins the supplied generation. It first checks current state, then subscribes to ordered host state/exit events without polling. It returns one successful outcome:

- `{ kind: "state", state, sequence }` for a requested state;
- `{ kind: "exit", exitCode, signal, sequence }` for PTY exit;
- `{ kind: "timeout" }` when the requested deadline expires; or
- `{ kind: "unknown", sequence }` when no reliable detector state exists.

`timeout` and `unknown` are results, not `idle`. Agent state remains heuristic: `idle` does not mean work is complete. Closing or replacing the pinned generation returns `STALE_TARGET` unless its matching exit event already completed the wait.

`createTab` accepts a target task ID, an enabled profile ID, and an optional initial prompt. It creates the tab in the caller tab's owning terminal host and returns its tab summary. Profile configuration remains host-owned; callers cannot supply commands, arguments, environment, or a working directory.

`promptTab`, `interruptTab`, and `closeTab` return the target and `affectedGeneration`. `closeTab` additionally reports whether the process was running. Acknowledgement means that the host operation ran, not that an agent understood a prompt or completed interrupted work.

### Mailbox delivery and acknowledgement

Messages are structured JSON values, not terminal text. `sendMessage` requires an exact target, a caller-generated `clientMessageId`, an optional `kind`, and `payload`.

The broker assigns a `messageId` and records sender/recipient task, tab, and generation plus accepted time. A successful send means the message was accepted into the recipient's in-memory mailbox. It does not mean the recipient read or acted on it.

Delivery is at-least-once until acknowledgement:

- `receiveMessages` returns unacknowledged messages for the authenticated caller generation, up to its requested limit. Concurrent receives may see the same message.
- `ackMessages` accepts up to 50 message IDs and returns separate `acked`, `alreadyAcked`, and `unknown` arrays. Acknowledgement is idempotent.
- Retries of `sendMessage` with the same `{ caller generation, clientMessageId }` return the original acceptance result and do not enqueue another message.
- Messages never cross a tab generation. Closing a recipient drops its mailbox; later sends to that generation return `STALE_TARGET`.
- Mailboxes and recent deduplication/ack records are runtime-only. Unacknowledged messages retain their deduplication record. After acknowledgement, message IDs and client-message deduplication records remain for one hour, capped at 10,000 records broker-wide with oldest-first eviction; a retry after eviction can be accepted as new. They survive a plugin hot reload with the same live sessions, but not Obsidian exit or process loss. They are never written to vault files or plugin data.

Clients must use mailbox reads after reconnect; notification events are only hints and are not a durable delivery channel.

### Multi-view authority

Opening multiple Work Terminal views does not create multiple brokers. Each `TerminalPanelView` registers a host with the vault broker using a broker-issued host ID and unregisters it on real disposal.

Each live `{ taskId, tabId, generation }` has exactly one registered host owner. A duplicate registration is rejected as `TARGET_UNAVAILABLE` and neither host is silently preferred. Existing-tab operations route only to that owner. A create request routes to the authenticated caller tab's owner, even when the target task is displayed in another view.

The broker catalogue is built from adapter/framework task APIs, not a view's filtered or currently rendered item list. Closing one view removes only its genuinely disposed tabs. Hot-reload handoff marks hosts as transferring rather than closed so restored live tabs retain identity, generation, token, mailbox, and ownership when the replacement host claims them.

### No-focus guarantee

Every version 1 broker method is background-only. There is no `focus` parameter. Broker execution must not:

- activate an Obsidian leaf or Work Terminal view;
- change the selected task;
- switch, show, focus, or scroll a terminal;
- open a detail view; or
- move keyboard focus.

Creating a tab uses a non-activating host primitive even if its task is currently selected. Reading and waiting operate on host state only. Prompt and message delivery do not focus or reveal the target. Closing the user's selected tab may cause that same terminal panel to select its remaining neighbour as an unavoidable consequence of removal, but must not activate a leaf or different task.

The broker boundary tests capture focus/selection before each operation and assert it is unchanged, except for the documented selected-tab removal case.

### Reload and reconnect

The endpoint name remains stable for the lifetime of the Obsidian vault window. During plugin hot reload:

1. the broker stops accepting requests;
2. pending requests receive `BROKER_RELOADING` when possible;
3. connections close and all pending waits are discarded;
4. live caller contexts, generations, mailboxes, tombstones, counters, and host-transfer records are handed through the existing window-global reload mechanism; and
5. the replacement broker rebinds the same endpoint with a new random `brokerEpoch`.

Clients reconnect with their existing token using bounded backoff, call discovery/list methods to rebuild current state, drain their mailbox, and establish new waits. Request IDs, event sequences, and subscriptions are not resumed. An operation without a success response has unknown completion; mutation retries rely on exact generations and, for messages, `clientMessageId` deduplication.

If reload recovery fails, the old endpoint is removed, contexts expire, and clients fail closed. Obsidian restart loses broker runtime state and live sessions.

### Bounds and rate limits

All sizes are measured after UTF-8 encoding. Limits apply before work is dispatched.

| Resource                                      | Version 1 limit                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Frame                                         | 65,536 bytes before newline                                                                   |
| Connections                                   | 4 per caller generation; 128 per broker                                                       |
| In-flight requests                            | 32 per connection                                                                             |
| Identifier                                    | 128 bytes, except request ID (64 printable ASCII characters)                                  |
| List page                                     | default 50, maximum 200; opaque cursor                                                        |
| Recursive hierarchy                           | default depth 8, maximum depth 32, maximum 500 results                                        |
| Live tabs per task for `createTab`            | 32                                                                                            |
| Clean-output ring per tab                     | oldest-first eviction above 256 KiB or 2,000 logical lines                                    |
| `readOutput`                                  | default 50 lines, maximum 200 lines and 48 KiB returned text                                  |
| Initial/create prompt and `promptTab`         | 16 KiB                                                                                        |
| Message `kind`                                | 64 bytes                                                                                      |
| Message payload                               | 8 KiB encoded JSON                                                                            |
| Mailbox                                       | 100 unacknowledged messages or 256 KiB per recipient generation; reject, never silently evict |
| `receiveMessages`                             | default 20, maximum 50                                                                        |
| Wait                                          | default 30 seconds, maximum 10 minutes; 16 concurrent per caller and 128 per broker           |
| Tombstones                                    | one hour, maximum 10,000                                                                      |
| Mailbox acknowledgement/deduplication records | one hour after acknowledgement, maximum 10,000 broker-wide                                    |
| Runtime audit ring                            | 1,000 entries, oldest-first eviction                                                          |

Authenticated requests have a rolling one-minute general limit of 120 per caller generation. The following stricter rolling one-minute limits also apply:

| Request          | Limit |
| ---------------- | ----: |
| `readOutput`     |    60 |
| new `waitForTab` |    30 |
| `sendMessage`    |    30 |
| `createTab`      |     6 |
| `promptTab`      |    20 |
| `interruptTab`   |    10 |
| `closeTab`       |     5 |

Denied and invalid authenticated requests count toward the general limit. Authentication failures are limited to 20 per endpoint per minute. A limit failure returns `RATE_LIMITED` with `retryAfterMs`; a size/count failure returns `LIMIT_EXCEEDED` with the applicable limit. Counters survive hot reload and reset on Obsidian restart.

### Structured errors and audit data

Errors use the normal response envelope:

```json
{
  "v": 1,
  "type": "response",
  "id": "r1",
  "ok": false,
  "error": {
    "code": "CAPABILITY_DENIED",
    "message": "The caller lacks prompt-tab",
    "retryable": false,
    "details": { "requiredCapability": "prompt-tab" }
  }
}
```

Version 1 error codes are:

| Code                  | Meaning                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `INVALID_FRAME`       | Invalid encoding, JSON, envelope, ID, or frame shape.                                       |
| `UNSUPPORTED_VERSION` | Protocol version is not supported.                                                          |
| `AUTH_REQUIRED`       | A request arrived before hello.                                                             |
| `AUTH_FAILED`         | Token is absent, invalid, expired, or stale.                                                |
| `CAPABILITY_DENIED`   | The caller or required recipient lacks the exact grant.                                     |
| `INVALID_ARGUMENT`    | A parameter is malformed or unsupported.                                                    |
| `LIMIT_EXCEEDED`      | A bounded input/result/concurrency limit was exceeded.                                      |
| `RATE_LIMITED`        | A rolling request limit was exceeded.                                                       |
| `NOT_FOUND`           | A task/profile/tab was never known in this runtime.                                         |
| `STALE_TARGET`        | The exact tab generation is closed, replaced, or mismatched.                                |
| `TARGET_EXITED`       | The generation exists but its process has exited and the operation requires a live process. |
| `TARGET_UNAVAILABLE`  | The authoritative host cannot currently perform the operation.                              |
| `MAILBOX_FULL`        | The target mailbox cannot accept another message.                                           |
| `BROKER_RELOADING`    | Reload handoff has begun; reconnect and reconcile.                                          |
| `INTERNAL`            | An unexpected host failure; no private details are exposed.                                 |

`details` contains only safe machine-readable fields such as argument names, required capability, limits, retry delay, or the requested target. Stack traces, environment, commands, output, prompt/message payloads, endpoint paths, and tokens are excluded.

The in-memory audit ring records timestamp, broker epoch, caller and target IDs/generations, method, allow/deny, error code, byte counts, and duration. It never records tokens, terminal output, prompts, message payloads, environment, or command arguments. This is diagnostic metadata, not durable history.

## Lifecycle findings carried forward from #581

The [Herdr lifecycle investigation](../investigations/herdr-agent-lifecycle.md) is retained with commit-pinned primary-source citations. The broker adopts only findings relevant to this boundary:

- Host/server ownership, caller-bound identity, monotonic ordering, and stale-generation rejection prevent delayed or cross-tab reports from becoming authoritative.
- Semantic hooks are authoritative only when they cover the full lifecycle. Herdr deliberately keeps screen detection authoritative for agents with partial hooks. The version 1 broker therefore consumes Work Terminal's existing detector transitions and PTY exit events; it does not add a second state machine or accept caller-reported lifecycle state.
- Screen state is heuristic and version-sensitive. `idle`, `unknown`, process exit, timeout, and completion are distinct. The broker never presents `idle` as confirmed completion.
- Runtime reports and events are lossy across disconnects. Reconnect means listing current state and resubscribing, while durable delivery requires the separate acknowledged mailbox.
- Herdr's transferable pattern is the narrow host-owned capability boundary, not its Rust PTY/workspace subsystem. Work Terminal keeps its existing terminal ownership and uses Node/Electron primitives.

## Consequences

The broker becomes the sole public test seam for this feature: framed requests in, structured responses/events out, plus externally visible host effects. Tests must not assert DOM, xterm, child-process, or reload-store internals.

Later implementation tickets must add host primitives, catalogue APIs, transport/settings/helper UI, waits, mailboxes, and mutations behind this contract. Changes to limits or compatible result fields may extend protocol version 1; changed authority, capability, targeting, delivery, or error semantics require a new ADR and, when incompatible, protocol version 2.
