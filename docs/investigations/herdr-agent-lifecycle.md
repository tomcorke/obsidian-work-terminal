# Herdr agent lifecycle investigation

**Issue:** [obsidian-work-terminal #581](https://github.com/tomcorke/obsidian-work-terminal/issues/581)  
**Herdr snapshot:** current `master` supplied for this investigation, commit [`e35f3937b0efe40ec0dab675709c68e1d8e8c9e6`](https://github.com/herdrdev/herdr/tree/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6)  
**Method:** primary-source review of both repositories' `CLAUDE.md`, `README.md`, implementation, bundled manifests/integrations, and Herdr docs. Links below are commit-pinned.

## Executive summary

Herdr does **not** replace terminal scraping with one universal agent API. It builds a layered, server-owned state machine:

1. identify the foreground agent process;
2. classify the live PTY bottom buffer plus OSC title/progress using per-agent, versioned TOML manifests;
3. accept direct lifecycle/session reports from agent hooks or plugins over a local socket;
4. arbitrate those sources centrally, with process exit, session identity, monotonic sequences, stale-report suppression, and transition stabilization; and
5. derive user-facing completion (`done`) from transitions and “seen” state rather than treating it as an agent-reported lifecycle state.

Herdr's semantic state enum is `Idle | Working | Blocked | Unknown`, not `active | waiting | idle | done`; Work Terminal's nearest mapping is `Working → active`, `Blocked → waiting`, `Idle → idle`, `Unknown/no agent → inactive`. Herdr's UI can say an agent is “done,” but that is completion/attention state, separate from the core enum. ([state enum](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/mod.rs#L10-L24), [completion fields](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L142-L170), [docs](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L118-L126))

**Recommendation:** do not embed Herdr or port its Rust terminal/process subsystem. The smallest useful replacement is an agent-neutral local lifecycle-report protocol in Work Terminal, authoritative when live and falling back to the existing xterm detector. Add official hooks only for agents whose hook surfaces cover the full lifecycle; keep buffer detection for Claude/Copilot and as universal fallback. Manifest-driven screen rules are a second, independent improvement if detector churn warrants them.

## Architecture and data flow

```text
PTY child
 ├─ foreground process/job probe ───────────────┐
 ├─ terminal emulator bottom-buffer snapshot ──┼─> detection task (~300 ms)
 ├─ OSC 0/2 title + progress ───────────────────┘       │
 │                                                       ├─ process identifies agent
 │                                                       ├─ manifest selects region/rule
 │                                                       ├─ idle stabilization / viewer suppression
 │                                                       └─ StateChanged event (fallback)
 │
 └─ agent hook/plugin
      └─ HERDR_* env → CLI or newline-delimited JSON socket
                           ├─ HookStateReported
                           ├─ AgentSessionReported
                           ├─ HookAuthorityCleared
                           └─ HookAgentReleased
                                      │
                                      v
                         TerminalState arbitration
                 hook authority / fallback / process exit / seq /
                 session owner / stale-generation suppression
                                      │
                                      v
                         effective agent + state + revisions
                                      │
                         pane/tab/workspace rollups, waits,
                         notifications and completion/seen state
```

### 1. Agent identity and screen fallback

Herdr first finds the foreground job and maps process names/aliases to 24 known agents; 22 have screen manifests. It can also take a per-process `HERDR_AGENT` hint when wrappers hide the real executable. ([agent registry and process identification](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/mod.rs#L26-L107), [foreground-job selection](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/mod.rs#L184-L236), [wrapper limitations](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L63-L71))

The pane detection loop normally polls every 300 ms. It probes the foreground process, reads the emulator's **live bottom** detection text (not the user's scrolled viewport), captures OSC title/progress, evaluates the identified agent's manifest, and publishes an internal event. It skips unchanged stable idle screens and skips screen reads while full-lifecycle authority is active, but still probes enough to notice process exit. ([detection loop](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/pane.rs#L801-L876), [process/authority flow](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/pane.rs#L897-L1030), [screen read and publish](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/pane.rs#L1031-L1113))

Manifests are data, not hard-coded branches. Rules have priorities, scoped regions, nested `all`/`any`/`not` gates, literal/regex/line-regex matchers, semantic state, visible-signal flags, and `skip_state_update`. The engine evaluates all rules and chooses the highest-priority match. No match for a known agent deliberately falls back to `Idle`; unknown process/no manifest yields `Unknown`. ([manifest schema](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/manifest.rs#L91-L194), [evaluation](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/manifest.rs#L430-L506), [fallback](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/manifest.rs#L508-L565))

The extra confidence fields matter: `visible_idle`, `visible_blocker`, and `visible_working` distinguish current UI chrome from a weak historical match; `skip_state_update` freezes state in transcript/history/model viewers rather than misclassifying stale content. Claude's manifest, for example, gives OSC/live-turn activity high priority, suppresses transcript/model viewers, recognizes strict live blockers, and recognizes its prompt box as idle. Codex similarly combines OSC blocked/working, viewer suppression, strict/weak blockers, and a screen-working fallback. ([detection metadata](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/mod.rs#L26-L43), [Claude manifest](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/manifests/claude.toml#L1-L107), [Codex manifest](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/manifests/codex.toml#L1-L112))

Manifests are bundled, can be remotely updated for already-known agents, and can be locally overridden. Invalid/newer-incompatible overrides fall back to cached remote or bundled rules. `herdr agent explain` exposes selected source/version/rule/evidence/fallback. ([loading and fallback chain](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/manifest.rs#L567-L677), [operational docs](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L84-L112))

### 2. Transition stabilization and exit

Herdr avoids a single scraped frame flipping `Working → Idle`: an idle result without visible idle/blocker evidence needs three 100 ms confirmations, capped at 700 ms. Stable visible blockers refresh every 800 ms; a newly detected process gets a three-second startup grace. Process exit bypasses ordinary classification and publishes visible `Idle`, then central state handling clears matching authority/session data and eventually the agent identity. ([constants and pending-idle policy](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/pane/agent_detection.rs#L5-L76), [publish policy](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/pane/agent_detection.rs#L122-L256), [exit classification](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/pane/agent_detection.rs#L268-L287), [exit cleanup](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L500-L650))

“Done” is therefore not a hook payload or core state. The terminal stores `last_agent_completion_seq` alongside state-change sequence, and UI docs describe “done” as an agent that stays highlighted until viewed. Consumers should model this as an edge such as `Working → Idle` plus acknowledgement, not add `done` to the producer protocol. ([terminal bookkeeping](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L142-L170), [state rollups](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L118-L126))

### 3. Direct reports and central arbitration

Every managed pane process inherits `HERDR_ENV`, pane/workspace/tab IDs, socket path, and (for integrations) the Herdr binary path. An integration sends `idle`, `working`, or `blocked`, optional block message, source, agent label, monotonic `seq`, and optional session ID/path or resume argv. CLI commands wrap equivalent socket methods: `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, and `pane.release_agent`. ([integration contract](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/add-herdr-support.mdx#L16-L104), [socket methods/environment](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/socket-api.mdx#L63-L80), [pane env injection](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/socket-api.mdx#L250-L252))

Reports become typed app events rather than mutating UI state directly. ([events](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/events.rs#L83-L158)) `TerminalState` owns arbitration: it rejects out-of-order sequences, conflicting process identities/session owners, stale session generations, and late reports after exit/release. A live **official full-lifecycle** integration is authoritative and screen updates are skipped; session-only integrations leave screen state authoritative; custom reporters can own an otherwise unknown agent. Process exit clears matching hook authority before effective state is recomputed. ([authority setup and sequence checks](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L661-L814), [full-lifecycle routing](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L900-L1080), [effective-source selection](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L2014-L2095), [final arbitration](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L2324-L2352))

The hard-coded official full-lifecycle allow-list is Pi, OMP, MastraCode, OpenCode, Kilo, and Kimi. Hermes, Qwen, Letta, and Antigravity are explicitly identity-only; other built-in hooks not on the full-lifecycle list likewise cannot suppress fallback for their whole lifetime. ([authority classification](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/detect/mod.rs#L283-L305))

## Supported-agent hooks/protocols

The table separates **state authority** from session restore; installing an integration does not necessarily improve lifecycle detection. Agents without an integration can still be screen-detected when listed in Herdr's manifest registry. ([support matrix](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L13-L61), [integration overview](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/integrations.mdx#L49-L56))

| Agent(s) | Events/hooks/protocol | Effective lifecycle source and fallback |
|---|---|---|
| **Pi** | TypeScript extension: `session_start` reports identity/current state, `agent_start` → working, `agent_settled` → idle; `herdr:blocked` reference-counts blockers. Reports over socket, coalesces queued states, and retries once. ([source](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/pi/herdr-agent-state.ts#L1-L246)) | Full-lifecycle authoritative while valid/live; screen manifest otherwise. |
| **OMP** | Pi-style TS extension plus nested-session suppression via `OMPCODE`; tracks active, question blockers, retries/provider failure with configurable idle debounce/retry grace, and session changes. ([source](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/omp/herdr-agent-state.ts#L1-L260)) | Full-lifecycle authoritative; OMP state requires integration because it is excluded from screen-manifest agents. |
| **Kimi** | `SessionStart`; prompt/tool/subagent/compact → working; `AskUserQuestion`/`PermissionRequest` → blocked; result/stop/interrupt transitions restore working/idle. ([registration](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/mod.rs#L72-L104), [reporter](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/kimi/herdr-agent-state.sh#L1-L68)) | Full-lifecycle authoritative; screen manifest fallback without/after authority. |
| **MastraCode** | Session, prompt/agent/tool/subagent, permission/result, interrupt/end/stop map to session/working/blocked/idle. ([registration](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/mod.rs#L290-L312), [reporter](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/mastracode/herdr-agent-state.sh#L1-L98)) | Full-lifecycle authoritative; state requires integration. |
| **OpenCode** | Pane-local TUI/plugin associates selected root session and descendants, reports busy/retry, permission/question blockers, errors, idle, selection changes; socket writes use 500 ms timeouts, serialized delivery and retries. Legacy local `run`/Mini server plugin maps chat/session/tool/question events and rejects child/cross-pane ownership. ([TUI routing/state](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/opencode/herdr-tui-session.js#L1-L244), [server plugin](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/opencode/herdr-agent-state.js#L1-L223)) | Full-lifecycle authoritative when installed; manifest fallback. Headless/Mini/shared-server topology has explicit coverage limits. |
| **Kilo** | JS plugin maps `idle`; active/busy/pending/running/streaming/working; tool/reply/compact; permission/question/error; socket timeout 500 ms. ([source](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/kilo/herdr-agent-state.js#L1-L167)) | Full-lifecycle authoritative; manifest fallback. |
| **Codex** | `SessionStart` reports identity; `UserPromptSubmit` → working; `Stop`/`Interrupt` → idle. Reports are session-bound and sequence-stamped. ([source](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/codex/herdr-agent-state.sh#L1-L100)) | **Hybrid, not full-lifecycle authority:** docs require `--no-daemon` for reliable pane routing; screen still detects blockers and gaps. ([docs](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/integrations.mdx#L113-L124)) |
| **Claude Code** | Only documented root `SessionStart` reports session ID/path/source; rejects Cursor-compatible and subagent events. ([source](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/claude/herdr-agent-state.sh#L1-L104)) | Screen/OSC manifest owns all lifecycle state. |
| **GitHub Copilot CLI** | Session-start hook only, with event normalization and session ID. ([source](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/copilot/herdr-agent-state.sh#L1-L88)) | Screen manifest owns lifecycle. |
| **Devin, Droid, Qoder, Qwen, Letta, Hermes, Antigravity, Cursor, Grok** | Built-in integration registry installs session-refresh/session-start plugins or hooks; lifecycle hooks were deliberately removed for several because coverage is incomplete. Hermes reports session on start/reset/observed resume; Antigravity documents why invocation hooks cannot safely express blocked/interrupt/exit. ([registry](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/mod.rs#L106-L212), [Hermes](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/hermes/__init__.py#L1-L79), [Antigravity rationale](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/mod.rs#L272-L289)) | Screen/OSC manifests own lifecycle; integrations primarily provide restore identity. |
| **Amp, Kiro, Maki, Gemini, Cline** | No Herdr-installed integration in the published support matrix. | Screen manifest only (Gemini/Cline explicitly less tested). |
| **Agent-native/custom agents** | Agent calls CLI or socket directly with semantic state, sequence, optional message/session/resume, and release. | Reporter owns state; returning to shell is a delayed safety-net release if explicit release is missed. ([contract](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/add-herdr-support.mdx#L35-L104)) |

## Comparison with Work Terminal today

Work Terminal's `AgentStateDetector` is much smaller and entirely client-local. Every two seconds it reads up to 30 non-empty lines around xterm's cursor, checks broad waiting patterns first, fingerprints the screen, and calls it active when the fingerprint changes or a configured/legacy spinner pattern matches; otherwise it calls it idle. It keeps 30 cleaned output lines only as a waiting fallback when the screen is empty. A visible tab intentionally downgrades `waiting` to `idle`, and reload gets a two-second active-suppression window. ([implementation](../../src/core/agents/AgentStateDetector.ts), especially `_readScreen`, `_check`, `hasAgentWaitingIndicator`, and `hasAgentActiveIndicator`; [mock-buffer tests](../../src/core/agents/AgentStateDetector.test.ts))

| Concern | Work Terminal | Herdr |
|---|---|---|
| State model | `inactive`, `active`, `idle`, `waiting` | `Unknown`, `Working`, `Idle`, `Blocked`; completion/seen tracked separately |
| Agent identity | Detector gets profile activity patterns; legacy Claude+Copilot heuristics | Foreground process/job identity plus aliases and wrapper hint |
| Primary evidence | xterm active buffer + change fingerprint | Direct reports when authoritative; otherwise emulator live-bottom + OSC + process state |
| Rules | Waiting logic is global/hard-coded; active patterns partly profile-configured | Versioned, prioritized, scoped per-agent manifests with explain output |
| Poll/latency | 2 s interval | ~300 ms, 100 ms during pending idle; direct event reports can be immediate |
| False-active control | Unchanged fingerprint becomes idle; 2 s reload suppression | Semantic hook events, strict rules, viewer suppression, three-confirmation working→idle |
| Exit/replacement | `stop()` stops polling; `inactive` is managed outside detection | Foreground process change/exit participates in authority and identity cleanup |
| Ordering/ownership | None | Monotonic per-source sequence, pane/session identity, stale generation and cross-talk guards |
| Attention semantics | Hidden waiting only; aggregation `waiting > active > idle > inactive` | Blocked/working rollups plus completion sequence and seen/unseen presentation |
| Maintenance | Code/profile update | Bundled/remote/local manifests; integration updates; `agent explain` diagnostics |

Herdr validates Work Terminal's original choice to inspect rendered terminal state rather than raw stdout, but shows that **buffer access alone is not the architectural improvement**. The major gains come from semantic producer events, agent identity, source arbitration, generation/ordering guards, and separating current lifecycle from “needs review.”

## Reliability limits and findings

1. **[High] Direct hooks are only better when they cover every transition and are correctly pane-bound.** Herdr deliberately leaves Claude, Copilot, Devin, Droid, Qoder, Hermes, Qwen, Letta, Antigravity and others screen-authoritative. Codex daemon routing can target the wrong pane; `--no-daemon` is recommended. Treating any installed hook as globally authoritative would freeze or misroute state. ([integration docs](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/integrations.mdx#L49-L56), [Codex warning](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/integrations.mdx#L113-L124))

2. **[High] State reports need ownership and generation checks, not merely a local HTTP/socket listener.** Agent subprocesses, shared servers, nested agents and delayed writes can report into the wrong tab or overwrite a newer session. Herdr's sequence, session reference, foreground-process confirmation, stale-session suppression, and OpenCode root routing are substantive correctness machinery. ([report routing](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/terminal/state.rs#L900-L1080), [OpenCode cross-talk handling](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/opencode/herdr-agent-state.js#L7-L18))

3. **[Medium] Screen detection remains heuristic and version-sensitive.** Strict blocker matching intentionally prefers false-idle over false-blocked, and known-agent no-match is idle. New UI wording, localization, narrow wrapping, alternate themes/motion settings, or stale scrollback can still defeat rules. Herdr mitigates this with regions, priority, visible-evidence flags, viewer suppression, remote manifests and explain diagnostics; it does not eliminate the limitation. ([blocked policy](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L73-L82))

4. **[Medium] Process detection is platform/topology-dependent.** Host wrappers, VMs/containers, restricted process APIs, nested tmux and shared daemons can hide or misidentify the foreground agent. Herdr exposes an opt-in hint/fallback and explicitly documents best-effort behavior. An Electron plugin using its existing direct child process handles has an easier identity problem for agents it launches, but still cannot infer nested/shared descendants perfectly. ([limitations](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L63-L71), [tmux limitation](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L110-L116))

5. **[Medium] Reports are lossy by design.** Integrations use short timeouts, often swallow failures, and may coalesce queued state. This protects agent latency but means the consumer must retain fallback detection and treat report authority as revocable rather than permanent. ([producer guidance](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/add-herdr-support.mdx#L106-L116), [Pi retry/coalescing](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/src/integration/assets/pi/herdr-agent-state.ts#L19-L53))

6. **[Low] Herdr's screen fallback intentionally optimizes for recognized agents, not arbitrary shells.** Unsupported agents appear as plain terminals unless they self-report. Porting manifests without reliable agent identity would reintroduce global-pattern false positives. ([docs](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/agents.mdx#L8-L16))

## External reusability

- **Protocol/design:** highly reusable. Herdr explicitly documents third-party support without a Herdr patch: environment discovery, semantic states, source, monotonic sequence, optional session/resume, release, short timeout, latest-state coalescing. This maps cleanly to a local Electron-side IPC server. ([agent integration guide](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/docs/next/website/src/content/docs/add-herdr-support.mdx#L1-L116))
- **Bundled hook/plugin assets:** technically reusable/adaptable under Herdr's Apache-2.0 license, but they are coupled to `HERDR_*`, pane IDs, Herdr's socket schema, install locations/config migrations, and Herdr-specific source allow-lists. Copying them creates an update burden and requires preserved notices/licensing. ([Cargo license metadata](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/Cargo.toml#L1-L10), [license](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/LICENSE))
- **Manifest engine/data:** reusable in concept, not drop-in. The TOML format is Herdr-specific and its region selectors depend on Herdr's terminal snapshot/OSC pipeline. A TypeScript implementation could use the same shape, but importing the Rust crate would pull in process/PTY/server assumptions and duplicate xterm state already present in Work Terminal.
- **Running Herdr as a sidecar:** poor fit. Herdr is itself a terminal workspace server and owns PTYs; Work Terminal already owns PTYs/xterm tabs. A sidecar would duplicate process ownership and require users to install/configure another runtime. Herdr's public socket is useful for agents running **inside Herdr**, not as a standalone detector service for another terminal host.
- **Upstream integration:** possible but not a replacement. Work Terminal could optionally subscribe to an already-running Herdr server only if Herdr owns the relevant panes. It cannot authoritatively report lifecycle for Work Terminal-owned PTYs without Work Terminal becoming a protocol producer itself.

## Smallest viable paths for Electron/Obsidian

### Path A - improve scraping only (smallest code change)

Keep `AgentStateDetector` and add two Herdr-derived ideas: a three-sample/short-cap `active → idle` stabilizer and agent-scoped prioritized rules (initially existing profile regexes, not a full TOML engine). Optionally capture OSC title through xterm parser hooks. This reduces flicker and false positives but remains heuristic and does not solve `done`, ownership, or hook latency.

**Use when:** #581 only seeks more reliable indicators without modifying external agent configs.

### Path B - local report protocol plus current fallback (**recommended MVP**)

At terminal launch, inject plugin-specific environment such as `WORK_TERMINAL_SESSION_ID`, `WORK_TERMINAL_REPORT_PATH` (Unix socket / Windows named pipe), and a random per-terminal capability token. Accept newline-delimited messages:

```json
{"session":"<tab UUID>","token":"<random>","source":"agent-hook","seq":1730000000000000000,"state":"working","message":null}
```

Store `reportedState`, source/session, last sequence, and report time beside each detector. While an explicitly configured **full-lifecycle** source is valid, use it; otherwise retain the existing xterm detector. On PTY exit/tab disposal, clear authority synchronously. Derive `done` locally from `active → idle` (or process exit after activity) and clear it when the tab is viewed; do not ask hooks to report `done`.

Start with one integration having reliable lifecycle coverage (Codex `--no-daemon`, or an agent/plugin already exposing complete events), and a generic documented reporter command for custom profiles. Do **not** install broad Claude/Copilot lifecycle hooks: Herdr's current master specifically keeps those screen-derived. Use `child_process.spawn`/Node `net`, already available in Electron; no dependency or Herdr binary is required.

**Minimum safety retained from Herdr:** random unguessable terminal capability, exact tab/session binding, strictly increasing per-source sequence, source allow-list/full-lifecycle flag, short producer timeout, process-exit authority clearing, and xterm fallback. Session-resume commands, remote manifests, metadata labels, arbitrary third-party takeover, and cross-restart authority are not needed for first value.

### Path C - full hybrid parity

Add per-agent manifest files, OSC input, process identity, explain diagnostics, install/uninstall UI for hooks, session-generation arbitration, and remote rule updates. This approaches Herdr's reliability across many agents but is a subsystem, not a detector refactor.

**Use when:** Work Terminal commits to supporting many independently evolving TUIs and can own ongoing hook/config migration and rule-update infrastructure. Until then, Path B plus the existing detector captures most of the benefit with far less surface area.

## Conclusion

Herdr's transferable insight is a hierarchy, not a regex collection: **agent semantic event when trustworthy → rendered terminal/OSC fallback → process exit/unknown**, with one state owner enforcing ordering and session identity. For Work Terminal, implement that hierarchy narrowly and preserve xterm scraping. Porting Herdr wholesale or treating every available hook as authoritative would add more failure modes than it removes.

## Sources reviewed

Kept primary sources: Herdr [`README.md`](https://github.com/herdrdev/herdr/blob/e35f3937b0efe40ec0dab675709c68e1d8e8c9e6/README.md), state/detection sources and manifests linked inline, bundled integration assets linked inline, and official agent/integration/socket docs linked inline; Work Terminal `README.md`, `CLAUDE.md`, [`AgentStateDetector.ts`](../../src/core/agents/AgentStateDetector.ts), and [`AgentStateDetector.test.ts`](../../src/core/agents/AgentStateDetector.test.ts). No secondary/SEO sources were used. Herdr's `CLAUDE.md` was read as requested but is repository working guidance, not product evidence, so it is not cited for lifecycle claims.

## Gaps

This was static source review. No Herdr agent was run to measure transition latency, false-positive/negative rates, Windows named-pipe behavior, or behavior across specific installed agent versions. The supplied current-master checkout had commit identity but the available tools did not provide shell commands to independently query git status, execute tests, or inspect staged files; those items are reported accordingly below.

<details>
<summary>Research acceptance report</summary>

```json
{
  "issue": 581,
  "criteria": [
    {
      "criterion": "Research Herdr current master from primary source with exact permalinks or paths",
      "status": "met",
      "evidence": "Reviewed supplied Herdr checkout at e35f3937b0efe40ec0dab675709c68e1d8e8c9e6; document uses commit-pinned GitHub links for implementation, manifests, integrations, docs, license, and README."
    },
    {
      "criterion": "Read both repositories' CLAUDE.md and README.md",
      "status": "met",
      "evidence": "Read worktree CLAUDE.md and README.md plus /tmp/herdr-research/master/CLAUDE.md and README.md before writing."
    },
    {
      "criterion": "Explain architecture/data flow, events/hooks/protocols per supported agent, fallbacks, reliability, external reuse, and Electron/Obsidian options",
      "status": "met",
      "evidence": "Covered in Architecture and data flow; Supported-agent hooks/protocols; Reliability limits and findings; External reusability; and Smallest viable paths."
    },
    {
      "criterion": "Compare with current AgentStateDetector terminal-buffer scraping",
      "status": "met",
      "evidence": "Comparison section traces current 2-second xterm polling, waiting/activity heuristics, visibility behavior, output fallback, and aggregation against Herdr."
    },
    {
      "criterion": "Research only; no unrelated code changes, commits, or pushes",
      "status": "met",
      "evidence": "Only docs/investigations/herdr-agent-lifecycle.md was written; no source edits, commits, pushes, or root-checkout changes were performed."
    }
  ],
  "changed_files": [
    "docs/investigations/herdr-agent-lifecycle.md"
  ],
  "tests": [
    {
      "name": "Automated tests",
      "status": "not_run",
      "reason": "Documentation-only investigation; no shell/test tool was available."
    }
  ],
  "commands": [
    "No shell commands executed; research used read/write tools only."
  ],
  "validation": [
    "Cross-checked Herdr state enum, manifest evaluator, pane detection loop, TerminalState arbitration, integration registry/assets, and official docs.",
    "Cross-checked Work Terminal detector implementation and mocked-buffer tests.",
    "All Herdr source citations are pinned to commit e35f3937b0efe40ec0dab675709c68e1d8e8c9e6."
  ],
  "residual_risks": [
    "Static review only; no runtime benchmarks or false-classification corpus was executed.",
    "Herdr current master may advance after the pinned commit; conclusions apply to the reviewed snapshot.",
    "The agent-by-agent table summarizes the published support matrix and representative/current registry behavior; implementation details may vary by agent version and platform."
  ],
  "staged_file_status": {
    "status": "not_verified",
    "reason": "No shell/git-status tool was available; this agent did not stage files."
  },
  "diff_summary": "Added one Markdown investigation; no code or configuration changes.",
  "review_findings": [
    {
      "severity": "high",
      "finding": "Do not make partial/session-only hooks authoritative; Herdr retains screen authority for agents whose hooks miss lifecycle transitions."
    },
    {
      "severity": "high",
      "finding": "Any local report channel requires per-terminal capability/session binding, monotonic ordering, and exit/generation cleanup to prevent stale or cross-tab state."
    },
    {
      "severity": "medium",
      "finding": "Model done as a locally derived completion/attention edge, not as an agent lifecycle state."
    },
    {
      "severity": "medium",
      "finding": "Recommended minimum is direct semantic reports with existing xterm fallback, not a Herdr sidecar or full Rust subsystem port."
    }
  ]
}
```

</details>
