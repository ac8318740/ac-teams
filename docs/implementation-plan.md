# ac-teams implementation history

**Status:** v0.0.1 is built and verified on Linux as of 2026-10-24. The [README](../README.md) introduces the package and links to its current guides. This file records implementation decisions and the original proposal.

The user approved implementation with these refinements:

- Warn about competing delegation tools instead of refusing coexistence. Keep normal child resources. Limits cover only ac-teams launches, not other launchers or same-user shell access.
- Require explicit root opt-in before reading project policy. Configuration alone cannot authorize a limit above 10.
- Stop, rather than detach, live members when exit is confirmed. Confirmation uses the separately implemented native Pi hook, not input interception.
- Separate task progress (`todo`, `in_progress`, `done`), ownership, and dependency readiness. Checkout reserves even blocked work; `start` requires completed dependencies. Release clears ownership without reopening done work; reopening is explicit and protects active/done dependents. This supersedes the initial claim-as-progress design. Schema 1 snapshots migrate atomically to schema 2, preserving IDs, owners, dependencies, and revisions.

The smallest complete implementation uses one atomically replaced `state.json` for messages and tasks, rather than a separate message journal. Mutations are not request-deduplicated; ambiguous retries require inspection. Notification acknowledgement records queuing, not reading, and does not guarantee at-least-once model execution across crashes. Worktree cleanup is explicit, never automatic.

Deterministic subprocess/socket/storage/Git tests, native Pi busy/idle/resume checks, an actual terminal confirmation test, model-free native SIGTERM/SIGKILL probes, package checks, and independent review passed. The paid smoke used 10 calls and Pi reported an estimated $0.0861. The [operations guide](operations.md#pi-dependency-advisory) records the host dependency advisory.

## Original proposal

The sections below preserve the design investigation and its proposed acceptance checks. Where they differ from the implementation, the [usage guide](usage.md), [operations guide](operations.md), and the refinements above take precedence. Their original future-tense recommendations are not additional pending work.

## Architecture: the root owns transport, not everyone's work

```text
root Pi extension
    |
    +-- coordinator: durable state, local socket, event delivery
    |       |
    |       +-- owns RPC pipes --> child Pi session
    |       +-- owns RPC pipes --> grandchild Pi session
    |
    +-- native root Pi session/transcript

child extension -- authenticated local socket --> coordinator
                     requests launch, tasks, messages, or stop
```

A child can delegate, but the coordinator launches every process. The recorded parent tree controls depth and stop permissions. Owning all RPC pipes at the root avoids a persistent service and makes root process death close every child's input pipe. Finishing an assignment changes an agent to idle; it does not close that pipe or exit the session.

Use Node platform APIs, Pi's peer APIs, and its schema dependency. No database, process supervisor service, or orchestration dependency is needed for this size. Use a small JSONL RPC transport rather than Pi's exported `RpcClient`: v1 needs explicit pipe ownership, EOF shutdown, process identity, and bounded shutdown escalation. The installed client's `stop()` sends SIGTERM and then SIGKILL after one second; its public interface does not provide the required graceful EOF control.

### Proposed source boundaries

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Register tools, guidance, flags, and Pi lifecycle handlers |
| `src/coordinator.ts` | Team membership, authorization, single-writer mutations, socket requests, notifications |
| `src/rpc-agent.ts` | Spawn Pi, correlate RPC responses, track settlement, stop processes |
| `src/store.ts` | Private local storage, durable writes, message search and cursors |
| `src/worktrees.ts` | Create optional worktrees and verify safe removal |

Keep task rules in the coordinator initially; do not create a generic scheduler. Add the Pi package manifest, TypeScript configuration, and tests only after approval.

## The three tools compose without prescribing a workflow

Proposed names and actions:

| Tool | Actions | Rules |
| --- | --- | --- |
| `team_agent` | Launch, list/status, stop, explicit resume, root limit update | Brief, cwd, optional worktree, model, and thinking level; return member and native session identifiers |
| `team_message` | Send, history, search | Notify all teammates or a nonempty explicit recipient set; all members can read all messages |
| `team_task` | Create, list/read, edit to-do work, claim, start, release, complete, reopen | Separate progress, ownership, and dependencies; blocked checkout is allowed, starting is gated |

Children receive their launch brief and normal project instructions, not the parent's conversation. Startup guidance explains how to pull shared messages and tasks. It asks agents to use the fewest useful teammates, consider thinking level, state edit ownership, and notify their parent before an in-scope split. Scope expansion or changed shared commitments requires approval. There are no fixed manager roles or file locks.

Stop authorization follows ancestry: a parent can stop its descendants, not a peer or ancestor. The user can override. Task ownership is separate: agents complete or release their own claims; a parent or the user can explicitly release an interrupted descendant's claim. Stop never silently releases or reruns work.

### Launch controls and precedence

- Defaults: depth 2, at most 10 live descendants including idle members. Root is depth 0 and does not consume a descendant slot.
- Root settings resolve in order: built-in defaults, user ac-teams configuration, project ac-teams configuration, explicit root launch flags. Descendants receive the resolved team policy from the coordinator, not authority to rewrite it.
- A ceiling above 10 requires explicit user authorization: a root startup flag, or a root tool request confirmed through the host UI. Configuration alone cannot silently raise it. In noninteractive mode, require the explicit startup override. Descendants cannot raise either ceiling.
- Lowering a live ceiling does not stop existing agents. Reject new launches until the proposed membership fits. Lowering depth prevents further over-depth launches; it does not kill existing members.
- Reserve a slot atomically before spawn; count starting and stopping processes until confirmed exited. Roll back failed startup reservations. Validate the requesting member and ancestry server-side, not from a caller-supplied depth.
- Read the spawning member's current model and thinking level for each launch. Pass provider/model and thinking explicitly to Pi; an explicit launch override wins. Validate support and fail clearly rather than silently routing to another model.

Configuration is convenience, not a security boundary. Members share OS-user access; shell access can bypass coordination policies.

### Normal Pi resources, with explicit readiness checks

Launch `pi --mode rpc` in the requested cwd, using the installed executable, a dedicated native session directory, and an explicit absolute `-e` path to ac-teams. Preserve normal package, extension, skill, model, authentication, and project-instruction loading. Do not use `--no-extensions` as the production shortcut.

Before sending an assignment, require a child readiness handshake proving that ac-teams registered, joined the expected Team, and sees the coordinator's policy. The handshake also reports competing delegation tools/resources. Reject startup on conflicts, missing resources, trust restrictions, or timeout; never continue with an ungoverned child. Normalize package paths to avoid loading ac-teams twice.

Known conflicts must be checked before spawning where discoverable from settings/resources, and again at child readiness before model work. A post-load readiness check cannot undo another extension's startup side effects. Supporting arbitrary unknown launchers or claiming full coexistence is outside v1; do not modify existing installations during this project.

## Durable state and atomic ownership

Store coordination data at `~/.acstack/ac-teams/teams/<team-id>/` regardless of cwd. Use private directories (0700) and private files/socket (0600). The product uses this directory name without depending on ACStack. Never send tasks or messages to GitHub, ACStack maps, or another tracker.

- `state.json`: member identities and ancestry, policy, task state, claims, session paths, and notification progress.
- `messages.jsonl`: append-only shared message history with monotonic sequence numbers and stable message IDs.
- `sessions/`: native Pi-managed session files; store references instead of copying transcripts.
- Coordinator socket and exclusive owner lock: runtime coordination only, with per-member credentials and validated request schemas.

Only the root coordinator writes. Serialize mutations in one request queue. Validate and commit each reservation in the same critical section: the task is to-do and unowned. Checkout does not start work and can reserve a blocked task. Starting requires ownership and completed dependencies. Atomic snapshot replacement uses a same-directory temporary file, flush, rename, and directory flush. Append and flush a message before notifying recipients. A successful mutation response follows durable persistence; use request IDs to make retries idempotent.

Validate dependency IDs and reject cycles. Freeze dependencies while a task is in progress or done; a reserved to-do task remains editable by its owner. Return unfinished prerequisites as derived `blockedBy`, not a stored progress value. Release clears ownership, returns in-progress work to to-do, and leaves done work done. Explicit reopening cannot invalidate in-progress or done dependents. A process crash marks the member interrupted but retains task progress and ownership visibly.

An exclusive team lock prevents simultaneous roots writing the same state. Check process identity, not PID alone, before deciding a lock is stale. If identity or liveness is uncertain, refuse takeover and report recovery steps rather than killing processes or breaking the lock automatically. Test these filesystem assumptions on supported local Linux filesystems; do not promise network-filesystem locking guarantees.

Retain all durable records until explicit user-authorized deletion. Refuse deletion while members are live. Do not log tokens or credentials. Document that coordination messages, launch briefs, and native transcripts can contain sensitive project data.

## Delivery wakes agents without model polling

Append each message once. Broadcast resolves to the other current members; an explicit recipient set selects notification targets, not access permissions. History/search remains team-wide, including messages between other members. Paginate by sequence/cursor and return bounded text matches without loading the entire history into the model.

The coordinator pushes sequence references to connected member extensions. Use Pi's custom message delivery to wake an idle agent and queue a follow-up while busy. Batch pending references per member to avoid a model turn for each message. Reuse the same notification ID after reconnect and keep recipient progress for deduplication. Treat delivery as at-least-once; do not promise exactly-once model execution across crashes.

An assignment is complete only after `agent_settled`, not the RPC prompt acknowledgement or an intermediate `agent_end`. Idle members remain available. Default notifications do not interrupt running tools; reserve steering for an explicit urgent instruction. Transport failure leaves pending notifications visible. No automatic model retry or task reassignment follows a crash.

## Stop, exit, and resume guarantees

| Situation | Proposed behavior | Guarantee boundary |
| --- | --- | --- |
| Parent requests stop | Stop descendants in that subtree, clear queued work, abort active work, close stdin, wait, then SIGTERM/SIGKILL on a timeout | Test graceful and forced paths; report forced exits |
| Assignment settles | Record idle; keep process and RPC connection open | Supported by Pi RPC lifecycle |
| Root native exit | Confirm while descendants are live, then stop them and retain records | Requires the local Pi pre-exit patch; installed Pi 1.4.0 supports cleanup only |
| Intermediate member exits unexpectedly | Coordinator observes exit and stops its descendants; preserve interrupted claims | Requires root still functioning |
| Root crashes or receives SIGKILL | Its owned pipes close; RPC children receive EOF and begin shutdown | Best effort; child/event-loop hangs or inherited pipe handles can defeat timely cleanup |
| Machine failure | Processes stop; reconcile records on next open | No cleanup hook or guaranteed final write |
| Native resume | Use `pi --session <path\|id>`; rejoin records after identity checks | Resume is a new process, not reconnection to old stdio |

Track only ac-teams-owned processes. Never enumerate and stop unrelated Pi sessions. Descendant process-group cleanup must be tested; arbitrary shell-spawned detached processes are not covered by a universal kill guarantee.

Expose session ID and path for every member. On explicit resume, verify that the old member is not still live, reserve capacity, and start the native session with the same membership binding. Keep its interrupted claims visible for explicit continuation or release. Never reconstruct a transcript or automatically replay its last assignment. A manually resumed member without its coordinator can inspect its transcript, but cannot launch team work until team recovery is explicit.

Because this coordinator lives in the root, automatic attachment to an orphan's existing RPC pipes is not supported. If post-crash processes remain live or uncertain, block replacement instead of running duplicate work. Switching/forking the interactive root session must not silently abandon the old Team: reject cancellable switches with live descendants unless they are explicitly stopped; a cloned/forked session must not inherit authority to the original Team.

## Exit confirmation: supported hook versus package interception

The earlier recommendation to omit confirmation in v1 was too restrictive. Confirmation can be built; the distinction is whether it uses a supported lifecycle hook or intercepts selected exit routes.

Verified installed behavior: `session_shutdown` has no cancellation result, and normal interactive shutdown stops the TUI before disposing extensions. `/quit` is handled directly by the interactive mode before extension command dispatch. `app.clear` and `app.exit` shortcuts are reserved, but `ctx.ui.onTerminalInput()` can consume raw input before built-in handling. Raw input interception is not a global shutdown gate: it must preserve editor, abort, paste, modal, and configured keybinding behavior, and cannot intercept another extension calling `ctx.shutdown()`.

The Pi prerequisite is implemented locally in `/home/acoote/projects/pi`, branch `feat/cancellable-exit-hook`. It is not committed, published, or installed. The implementation uses no private-method replacement or copied third-party code.

Verification passed: 73 focused tests, `npm run check`, and real-terminal checks for `/quit`, Ctrl+D, double Ctrl+C, extension-requested exit, cancellation/retry, and SIGTERM during confirmation. No model prompts were sent.

Hook behavior and the proposed ac-teams integration contract:

- Pi emits `session_before_exit` before interactive terminal teardown. Returning `{ cancel: true }` keeps Pi open; a handler error also cancels exit and is reported.
- `/quit`, exit keybindings, and extension-requested graceful exit use the hook. Concurrent exit requests share one pending check; cancellation leaves Pi usable. Reload and session replacement do not emit it.
- In ac-teams, prompt only for a root with live descendants, including idle members: cancel exit, or stop descendants and exit while retaining records. Any detach/keep-running choice needs a separate lifecycle decision; it is not implied by confirmation.
- Do not prompt on SIGTERM, SIGHUP, terminal loss, noninteractive exit, or crashes. Preserve best-effort cleanup; SIGKILL and machine failure cannot run a hook.
- Test exit routes, cancellation, repeated requests, busy agents, no-live-member exits, cleanup, and unavailable UI. Until Pi supports the hook, a package-only exit command or input guard must explicitly document its bypasses.

Prior art checked on 2026-10-24:

| Project | Actual mechanism | Reuse assessment |
| --- | --- | --- |
| [sidstack/pi-codex-agents](https://github.com/sidstack/pi-codex-agents/blob/ae789448a8b1724075343d3341e99d04c628a1a6/src/core/host.ts#L145-L198) | Exit menu for its managed sessions; replaces the owned interactive mode's private `shutdown` and signal methods | Closest working design reference, but not a drop-in supported hook. Do not import its daemon/UI architecture or private-method patch for this tools-only package. MIT |
| [atayarani/pi-close-guard](https://github.com/atayarani/pi-close-guard/blob/54f9be0872b9881e57b0d1ddd34ba7608769f6c8/extensions/close-guard.ts) | Uses cancellable `session_before_switch` for `/new` and optionally `/resume`; explicitly excludes `/quit` | Useful confirm/cancel pattern, not an exit solution. MIT |
| [j1nn0/pi-extensions, pi-exit](https://github.com/j1nn0/pi-extensions/tree/78b556daf6dcd02757aec77077f278c39944c71d/packages/pi-exit) | Dedicated exit command/tool and keyboard shortcut | Example of requesting exit, not vetoing built-in shutdown. MIT |
| [getsimpledirect/vinci-code-cli](https://github.com/getsimpledirect/vinci-code-cli/blob/33b4ae7b6788c07a9c7e5109b083ae1e313aff4e/packages/coding-agent/src/core/extensions/runner.ts) | Defines `session_before_exit` in a fork for one-shot modes, without cancellation | A matching name does not supply the interactive cancellable behavior. MIT |

No third-party implementation was copied or installed. If code is adapted, retain the relevant copyright and MIT permission notice and identify the project, source commit, and adapted files in third-party notices. Acknowledgment alone does not replace the license notice. Upstream API evidence was checked at [earendil-works/pi commit d0aa218](https://github.com/earendil-works/pi/blob/d0aa218cb16c333c008f6aa3dcd670ac8b68383c/packages/coding-agent/src/core/extensions/types.ts). These are static source findings, not runtime verification of third-party exit behavior.

## Worktrees preserve work by default

A launch can use its supplied cwd or request a worktree. For a worktree, resolve the repository and base commit before spawning. Default to that repository's current HEAD; accept an explicit base ref. Do not fetch, checkout, reset, merge, or stash another working tree. Use an ac-teams-specific branch name containing team/member identifiers and pass Git arguments without shell interpolation.

Creation records repository, resolved base, branch, path, and an optional user-authorized integration target. Branch selection must reject collisions and invalid refs.

Automatic worktree removal is allowed only after the member has stopped, the tree is clean including untracked files, and its HEAD is an ancestor of the recorded integration target's current commit. Recheck immediately before removal. Missing target, uncertain status, or squash/rebase integration without ancestry proof means retain the tree and explain why. Never use force removal. V1 does not delete branches automatically and never treats stopping an agent as permission to merge.

## Implementation order and acceptance checks

Each step adds focused tests before it is considered complete. Before writing tests, follow the test-conventions skill and choose ordinary unit/integration tests for this standalone package, not ACStack application conventions.

1. **Package and child lifecycle.** Register the extension, root coordinator, readiness protocol, and RPC transport. Check normal cwd resources, explicit package loading, no parent-conversation inheritance, model/thinking inheritance and overrides, idle reuse across two assignments, and native session IDs/paths. Fail closed on both installed competing launchers. Bound output buffers and shutdown waits; always drain stderr.
2. **Durable tasks and limits.** Race simultaneous claims and launches; exactly one claimant wins, dependencies and cycles are checked, team/depth caps include idle agents, and startup failures release only their reservations. Test owner permissions, lower-limit behavior, request retries, disk failure, truncated message-tail recovery, duplicate roots, and crash-preserved claims.
3. **Messages and notifications.** Test broadcast and explicit multiple recipients, team-wide search, pagination, idle wake-up, busy follow-up, settlement, notification batching/deduplication, disconnection, and no periodic model polling. Define behavior for invalid/departed recipients explicitly and reject invalid recipient sets before append.
4. **Failure and resume.** Exercise orderly stop, queued-work cancellation, intermediate failure, root SIGTERM/SIGKILL, EOF, a child ignoring termination, and explicit native resume. Check no unrelated process is touched, no duplicate member starts, and no interrupted claim silently changes owner. Document observed best-effort limits.
5. **Worktrees and usage guidance.** Test clean and dirty repositories, branch collisions, integrated/unmerged heads, untracked files, absent targets, and safe cleanup. Add concise examples of child delegation and parent notification. An optional short Herdr skill may reference `herdr --skill`; it must not become a runtime dependency or a second messaging implementation.

Use fake RPC peers for deterministic protocol tests and real Pi processes for lifecycle/resource checks. A small paid-model smoke test is needed for two real assignments, busy/idle messaging, and tool-guidance behavior; do not confuse the no-model probe below with that verification. No frontend or dashboard verification is required for this tools-only scope.

## API evidence and investigation limits

The evidence below describes the installed package; the separate local Pi patch is documented above. Package root: `/home/acoote/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/`.

| Evidence | Supports |
| --- | --- |
| `docs/extensions.md`, `dist/core/extensions/types.d.ts:1229-1300` | Tool registration, extension flags, custom/user messages, model/thinking access |
| `docs/sdk.md`, `dist/core/resource-loader.d.ts:70-124` | SDK session/resource APIs; normal cwd loading and explicit additional resources |
| `dist/core/resource-loader.js:409-422` | Resource merging and extension loading; an after-load override is not proof of safe conflict prevention |
| `docs/rpc.md`, `docs/rpc-commands.md` | Persistent JSONL RPC; prompt/steer/follow-up, clear queue, abort, state, and settlement |
| `docs/rpc-extension-ui.md` | RPC UI requests require host responses; headless approval needs explicit policy |
| `dist/modes/rpc/rpc-mode.js:579-650` | Shutdown on stdin EOF and native runtime disposal |
| `dist/modes/rpc/rpc-client.js:89` | Exported client's limited stop sequence |
| `dist/modes/interactive/interactive-mode.js:3444-3488`, `dist/core/extensions/types.d.ts:637` | Shutdown ordering, non-cancellable shutdown event, emergency-exit limits |
| `docs/cli.md`, installed `pi --help`, `docs/sessions.md` | Native `--session <path\|id>` resume and session persistence |
| `docs/packages.md`, `docs/configuration.md`, `docs/settings.md`, `docs/security.md` | Package resources, settings/trust, and extension security limits |
| Installed `@tintinweb/pi-subagents` 0.22.0 and `pi-subagents` 0.81.0 | Independent delegation and lifecycle behavior; both MIT, neither required or copied |

A temporary, isolated real-Pi probe disabled all optional extensions/skills/templates/themes and sent no model prompt. It verified successful `get_state`, `get_commands`, `clear_queue`, and `abort` responses; continued availability between commands; native session ID/path reporting; and exit code 0 after stdin EOF. The first probe timed out because its Python text-buffered selector reader missed buffered lines; switching the probe to byte reads resolved that harness error.

At the end of the initial investigation, extension coexistence/readiness, paid model turns, busy message delivery, concurrent claims, parent-death cleanup, native resume/rejoin, and worktree safety were still unverified. Those checks were subsequently exercised during implementation; see [recorded verification](development.md#recorded-native-pi-verification) and [operational limits](operations.md). Publishing, marketplace integration, and ACStack changes were outside the initial local delivery. Current [publishing instructions](development.md#stage-releases-for-npm-approval) are separate from that history.
