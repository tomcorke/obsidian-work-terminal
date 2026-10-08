# Work Terminal task tab broker

Use the bundled `task-tab-broker.js` helper only when all `WORK_TERMINAL_BROKER_*` context variables are present. The helper refuses to run outside an opted-in Work Terminal agent tab; never invent an endpoint, task ID, tab ID, generation, or token.

## Calling the broker

```sh
node /path/to/work-terminal/task-tab-broker.js listCategories
node /path/to/work-terminal/task-tab-broker.js listTasks '{"categoryId":"active","limit":50}'
node /path/to/work-terminal/task-tab-broker.js getTask '{"taskId":"<stable-task-id>"}'
node /path/to/work-terminal/task-tab-broker.js listTabs '{"taskId":"<stable-task-id>"}'
node /path/to/work-terminal/task-tab-broker.js getSubtasks '{"taskId":"<stable-task-id>","maxDepth":8}'
node /path/to/work-terminal/task-tab-broker.js getParentTasks '{"taskId":"<stable-task-id>","maxDepth":8}'
node /path/to/work-terminal/task-tab-broker.js readOutput '{"target":{"taskId":"<id>","tabId":"<id>","generation":1},"maxLines":50}'
node /path/to/work-terminal/task-tab-broker.js waitForTab '{"target":{"taskId":"<id>","tabId":"<id>","generation":1},"states":["idle","waiting"],"timeoutMs":30000}'
```

The helper authenticates from its injected caller context, reconnects with bounded backoff during plugin reload, and prints one structured response. A non-zero exit means the response or transport failed.

## Safety rules

- Treat the caller returned by the broker hello as authoritative. Injected IDs describe launch context and may be stale after a task move.
- Use complete `{taskId, tabId, generation}` targets returned by `listTabs`; never target labels or array positions.
- Capabilities are exact and independent. `CAPABILITY_DENIED` means the profile must be changed by the user; do not work around it.
- All calls are vault-local and background-only. They do not focus tabs or expose xterm, process, DOM, workspace, or filesystem handles.
- Output and hierarchy results are bounded. Check `truncated`, cursors, missing IDs, cycles, and structured errors rather than assuming completeness.
- Runtime state is not durable. After reconnect, list current tabs again before using a target. A wait is never replayed across reload; list tabs, take the current generation, then start a new wait.
- `waitForTab` always observes process exit and otherwise waits for one of the requested `active`, `idle`, or `waiting` states. Handle `state`, `exit`, `timeout`, and `unknown` as distinct outcomes.
- Never print, persist, send, or include `WORK_TERMINAL_BROKER_TOKEN` or the endpoint in diagnostics.
- Agent state is heuristic. `idle` is not proof that work completed.

Only discovery, bounded output reads, and lifecycle waits are available in this release slice. Later broker methods require their separately named profile grant and should not be guessed before the host advertises them.
