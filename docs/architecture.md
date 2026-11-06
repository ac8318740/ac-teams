# Source responsibilities and ownership

ac-teams runs one coordinator per team inside its owning main session, without a separate daemon. It owns live member handles and durable team changes. Other main sessions and members connect as authenticated clients.

## Find the owner of a change

```text
src/
    index.ts       Pi entrypoint and extension identity
    types.ts       shared team records, requests, and role rules
    process.ts     Linux process identity and liveness
    text.ts        terminal-safe text
    extension/     Pi session binding, notices, tools, commands, and UI wiring
    team/          coordination, authenticated protocol, tasks, and messages
    members/       Pi processes, terminals, resource readings, and worktrees
    sandbox/       filesystem/network enforcement, Docker runtime, and assets
    settings/      trusted launch/display policy and loaded-extension selection
    ui/            terminal panels, rendering, graphs, and configuration views
```

`src/index.ts` remains the package entrypoint. Old top-level internal paths, such as `src/store.ts` and `src/coordinator.ts`, were removed without forwarding modules. Deep source imports are internal; use the responsibility directories when working on this repository.

## Keep each rule and resource with its owner

| Contract | Owner | Caller responsibility |
| --- | --- | --- |
| Bind a Pi session to its team as owner or client | [`extension/session.ts`](../src/extension/session.ts) | Tools, commands, events, and presentation use the same session lifecycle |
| Coordinate launches, stops, recovery, and shutdown | [`team/coordinator.ts`](../src/team/coordinator.ts) | Supply Pi-specific credentials, notifications, and session options |
| Authenticate connections and enforce request/readiness rules | [`team/protocol.ts`](../src/team/protocol.ts), [`team/requests.ts`](../src/team/requests.ts) | Treat socket input as untrusted; route accepted operations to coordination |
| Commit one durable mutation | [`team/store.ts`](../src/team/store.ts) | Mutate only the draft provided by `Store.update` |
| Start and stop an owned Pi process | [`members/rpc-agent.ts`](../src/members/rpc-agent.ts), [`members/terminal-agent.ts`](../src/members/terminal-agent.ts) | Coordination retains handles and waits for cleanup |
| Prepare and release enforced member resources | [`sandbox/runtime.ts`](../src/sandbox/runtime.ts) | Use restricted spawn options; never fall back to an unsandboxed launch |
| Select from the parent's actually loaded extensions | [`settings/worker-extensions.ts`](../src/settings/worker-extensions.ts) | Supply the observed loaded paths; a preset cannot widen the parent set |
| Show and act on team state | [`ui/panel.ts`](../src/ui/panel.ts) and its panel host contract | Pi integration supplies actions; UI does not write snapshots |

These modules hide their own protocol, process, persistence, or rendering details. Shared types, process checks, and text helpers stay small. Snapshot validation uses the pure [`extension-selection.ts`](../src/settings/extension-selection.ts) validator without loading Pi's extension runtime.

### One transaction owns tasks, outcomes, and watches

`Store.update` clones the current state, runs the mutation, validates the draft, flushes it, and publishes it in memory. [`team/tasks.ts`](../src/team/tasks.ts) and [`team/messages.ts`](../src/team/messages.ts) mutate that draft; they do not write files. Completing a task, adding its outcome post, and triggering its watches share one update.

[`team/snapshot.ts`](../src/team/snapshot.ts) owns schema validation, migrations from versions 1 through 4 to version 5, private-file checks, and snapshot I/O. Store owns the exclusive PID/boot/start-time lock.

Snapshot writes fsync the private temporary file, rename it, and fsync the directory. A failure never publishes the draft in memory. If directory fsync fails after rename, disk may already hold the new snapshot; inspect state before retrying an ambiguous request.

### Coordination owns startup and shutdown ordering

Coordination reserves capacity and an optional task assignment before awaiting member startup. [`team/launch.ts`](../src/team/launch.ts) prepares resources and waits for readiness before delivering work. A failed launch stops its process, releases sandbox resources, and returns only an untouched reservation. [`team/sessions.ts`](../src/team/sessions.ts) owns promotion, transcript moves, and rollback.

The coordinator retains active operations and process handles. Shutdown records handover state, stops descendants, waits for outstanding operations and container cleanup, closes sockets and terminal resources, and finally releases Store ownership. Process transports retain their signal escalation and Linux identity checks.

### Notice delivery ends with durable acknowledgement

The coordinator offers addressed posts through the protocol. [`extension/notices.ts`](../src/extension/notices.ts) acknowledges them after Pi persists the transcript entry. Receipt cursors belong to one team/member pair. A reconnect can offer an unacknowledged post again; offering it alone does not mark it delivered.

## Use file size as a review prompt

Aim for about 300 source lines per file. Keep a longer module when splitting it would obscure one responsibility or scatter resource ownership:

- `team/coordinator.ts` keeps composition, owned live handles, and ordered shutdown together.
- `extension/session.ts` keeps owner/client linking, takeover, join/leave, and session teardown on the same lifecycle state.

Tests are grouped by behavior and have no line cap. Existing cohesive suites need not mirror the source directory tree. See [development checks](development.md#run-local-checks).

[Back to README](../README.md)
