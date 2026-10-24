# ac-teams

Persistent Pi agents, shared tasks, and searchable messages, without a workflow engine or a background service. A member stays alive after an assignment so the same session can take more work.

Local v0.0.1 implementation, tested on Linux with Pi 1.4.0. Not published to npm.

## Features at a glance

Each column shows ac-teams alone or with one companion tool. A check mark (✓) means that setup provides the feature; a dash (-) means it does not.

| Feature | Standalone ac-teams | + ACStack | + Herdr |
| --- | --- | --- | --- |
| Persistent Pi members and native session resume | ✓ | ✓ | ✓ |
| Shared tasks, dependencies, and searchable messages | ✓ | ✓ | ✓ |
| Optional isolated Git worktrees | ✓ | ✓ | ✓ |
| Planning, review, and shipping skills | - | ✓ | - |
| Terminal tabs, panes, and visible root sessions | - | - | ✓ |

ACStack adds workflow guidance; Herdr adds terminal management. These are companion capabilities, not automatic integrations. ac-teams members run headlessly; Herdr does not automatically open a pane for each member.

## Try it locally

Requirements: Linux, Node 22.19 or newer, and an authenticated `pi` executable on `PATH`.

```sh
npm ci
pi -e /absolute/path/to/ac-teams/src/index.ts
```

Load the extension once, either explicitly or through Pi package settings. Children load ac-teams explicitly and otherwise keep normal Pi extensions, skills, authentication, and cwd instructions. They receive their brief, not the parent's conversation.

Use Pi's `/trust` command to approve each member's cwd before launching there. RPC children cannot answer Pi's initial trust prompt. ac-teams rejects readiness if project resources were skipped; it never auto-approves a project. A one-run approval in the root is not a saved approval for children or new worktrees.

Other delegation tools can coexist. ac-teams warns when `Agent`, `SubagentWorkflow`, or `subagent` is active, but does not disable them. **Its limits cover only members launched through `team_agent`.** Use Pi's resource settings to disable other launchers if you want one team authority. Shell access and same-user extensions are not sandboxed.

## Three tools, no prescribed workflow

| Tool | Actions | Main rule |
| --- | --- | --- |
| `team_agent` | `launch`, `list`, `status`, `stop`, `resume`, `limits`, `cleanup` | A parent controls its descendants, not peers or ancestors |
| `team_task` | `create`, `list`, `read`, `edit`, `claim`, `start`, `release`, `complete`, `reopen` | Checkout reserves work; dependencies gate starting, not ownership |
| `team_message` | `send`, `history`, `search` | Recipients select who is notified, not who can read |

`/teams` shows member status and native session/worktree locations. `/teams stop` stops every descendant. The root opens coordination state lazily on the first team request.

### Give members bounded assignments

Example `team_agent` arguments:

```json
{"action":"launch","brief":"Review src/parser.ts. Read only; do not delegate or edit. Send findings to root through team_message."}
```

`cwd` defaults to the requesting member's directory. `model` (`provider/model`) and `thinking` default to that member's current selection. An explicit override wins. Native Pi selects the model; provider/account rejections remain visible in member status and notify the parent. There is no automatic model retry.

Launch returns a stable member ID, PID, cwd, and native session ID/path. Finishing a turn makes the member idle only after Pi reports `agent_settled`. It does not stop the process.

Children can delegate through the same coordinator, subject to depth and capacity. Delegation still needs user authorization. Keep briefs bounded, agree on file ownership, and use separate worktrees for concurrent writers.

### Share work without losing ownership

```json
{"action":"create","title":"Review parser errors","description":"Check malformed input and report concrete failures; no edits."}
```

Each task has three independent parts:

- **Progress:** `status` is `todo`, `in_progress`, or `done`
- **Ownership:** `owner` is one member ID, or absent
- **Dependencies:** `dependencies` lists prerequisite task IDs. Returned `blockedBy` lists those not yet done; it is calculated, never stored as a status.

Use the returned task ID with these actions:

| Action | Effect |
| --- | --- |
| `claim` | Reserve an unowned to-do task, even if blocked. Progress stays `todo`. |
| `start` | The owner moves `todo` to `in_progress`, only when every dependency is `done`. |
| `complete` | The owner moves `in_progress` to `done`, with `acceptance: true`. Ownership remains. |
| `release` | Clear ownership. In-progress work returns to `todo`; done work stays `done`. |
| `reopen` | Explicitly move `done` to `todo`, retaining any owner. Refused if a dependent is in progress or done. |

Only the owner can start, complete, or release its work. An ancestor may explicitly release a stopped or interrupted descendant's ownership. The owner or root can reopen an owned task; any member can reopen an unowned one. Done tasks cannot be claimed until reopened.

Include `dependencies` on creation or `edit`. Any member can edit unowned to-do work; only the owner can edit reserved to-do work. In-progress and done tasks cannot be edited. Unknown dependencies and cycles are rejected. An optional `revision` rejects stale mutations.

`acceptance: true` asserts that the agent checked the acceptance criteria; it is not an independent test runner. Stop/crash retains ownership and progress. There is no automatic reassignment.

### Send messages instead of polling

```json
{"action":"send","recipients":["root"],"text":"Parser review complete. No edits; two malformed-input cases need tests."}
```

Omit `recipients` to notify all other live members. Explicit sets must contain unique live member IDs; an invalid set rejects the whole send. All team members can read the full history, including direct messages.

```json
{"action":"history","after":0,"limit":20}
```

Use the last returned `seq` as the next `after` cursor. `search` adds a case-sensitive literal `query`; results remain cursor-paged. Reads never consume messages. Task and message result pages are limited to 100 items.

New messages queue a compact Pi follow-up: an idle member wakes, while a busy member finishes its current work first. Notifications batch for 50 ms and reference history rather than copying every message into context. Notification acknowledgement means queued, not read or acted on. Messages survive crashes; exactly-once delivery or model execution does not. Avoid acknowledgement-only replies.

## Limits are ceilings, not staffing targets

Default: at most **10 live descendants**, counting starting, busy, idle, and stopping members. Root does not consume a slot. Default depth is **2**: root, child, grandchild. Use the fewest useful agents.

Root policy precedence:

1. Built-in defaults
2. `~/.acstack/ac-teams/config.json`
3. `.pi/ac-teams.json`, only with `--teams-project-config`
4. Explicit `--teams-limit` and `--teams-depth` flags

Config files accept only `limit` and `depth`, for example `{"limit":4,"depth":2}`. Limits must be 1–100; depth must be 0–10. A value above 10 requires an explicit root startup flag or interactive confirmation of a root `limits` tool request. Configuration alone cannot raise it. Lowering limits does not kill existing members; it blocks further launches until capacity fits.

```sh
pi -e /absolute/path/to/ac-teams/src/index.ts --teams-limit 4 --teams-depth 1
```

## Stop, resume, and keep work safe

`stop` stops the member's descendants deepest-first, clears queued work, aborts the turn, and closes the owned RPC pipe. Hung processes escalate to SIGTERM and then SIGKILL, with a warning. Escalation requires a matching captured process-group identity; uncertain ownership is refused. This is snapshot-based cleanup, not OS containment: detached or uncaptured descendants and identity-check races remain outside the guarantee.

`resume` needs a stopped descendant ID and a new brief. It starts a new process against the same native Pi session file; it does not reconstruct a transcript, reconnect to old stdio, or replay the previous assignment automatically. Resume is refused if the old process is live or its identity is uncertain.

Root session switching, forking, and tree traversal are blocked while members are live. A member cannot switch away from its team binding. Stop members explicitly before replacing the root session.

**Exit confirmation requires Pi's `session_before_exit` hook.** The prerequisite is implemented in the separate local Pi checkout described in [the implementation history](docs/implementation-plan.md#exit-confirmation-supported-hook-versus-package-interception), not in installed Pi 1.4.0. With that hook, native exit asks before stopping live members; cancellation leaves them running. Without it, shutdown performs cleanup but cannot ask first. Signals bypass confirmation.

If the root crashes, closing its owned pipes and losing the coordinator connection makes ordinary RPC children shut down. This passed SIGTERM and SIGKILL probes with native child and grandchild processes. It is best effort, not a guarantee against a hung event loop, machine failure, or detached shell processes. Recovery refuses duplicate work when a previous member is still live or uncertain.

### Optional worktrees

Set `worktree: true` on launch. `base` defaults to the repository's HEAD; `target` records the branch/ref against which later cleanup must prove integration. Worktrees live under a sibling `.ac-teams-worktrees` directory. No fetch, merge, stash, or checkout of the original directory occurs.

Stopping never deletes a worktree. `cleanup` is explicit and requires a stopped member, a clean tree including ignored/untracked files, and HEAD ancestry proven against the recorded target's current commit. Missing targets, dirty work, and uncertain/squashed integration retain the tree. Cleanup never forces removal and retains the branch. Cleanups and resumes exclude each other.

Worktree creation copies committed content, not uncommitted project configuration. Approve the new cwd through native Pi trust before retrying a launch that could not load its project resources. A failed launch retains its created worktree and member record.

## Local records and security boundaries

Each root session uses `~/.acstack/ac-teams/teams/<session-id>/`:

- `state.json` contains membership, policy, tasks, messages, claims, and notification cursors
- `sessions/` contains native Pi-managed member transcripts
- `owner.lock` and `coordinator.sock` coordinate the running root

State schema 2 separates ownership from progress. On reopening an older team, the coordinator atomically migrates schema 1: `pending` becomes `todo`, `claimed` becomes `in_progress`, and `completed` becomes `done`. IDs, owners, dependencies, and revisions are preserved. Invalid snapshots are rejected without replacement. Older ac-teams code cannot reopen the migrated schema; stop old sessions before updating.

Only the root writes state. Mutations validate a copy, flush a temporary snapshot, atomically rename it, and flush the directory before returning success. An exclusive process-identity lock prevents concurrent owners. Private team directories use 0700; state files and the authenticated Unix socket use 0600. Uncertain locks fail closed.

This is a small-team store: each mutation rewrites the snapshot, and search scans local history. There is no database, compaction, retention policy, automatic deletion, or deduplication of repeated mutation requests. Inspect state before retrying an ambiguous failed request. Records and transcripts can contain sensitive project data. Permissions protect against other users, not agents running as the same OS user.

`npm audit` currently reports Pi 1.4.0's pinned `undici` dependency (including a high-severity advisory). ac-teams adds no HTTP client and cannot repair an existing host installation. The suggested npm fix downgrades Pi incompatibly; it has not been applied. Review the host dependency before deployment.

## Development and verification

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The deterministic suite covers task reservations, progress, dependency readiness, release/reopen rules, durable migration, real subprocesses, sockets, notification batching, shutdown escalation, worktree safety, and lifecycle races. It makes no model calls.

Additional local checks on 2026-10-24:

- Native Pi busy follow-up, idle wake with the same PID, and resume with the same session ID/path and a new PID
- Normal project-extension loading and a 10-call model smoke using the existing default model; Pi reported an estimated $0.0861
- Actual ac-teams exit confirmation, cancel/retry, and child cleanup in a real terminal using patched Pi and a model-free RPC child fixture
- Native child/grandchild cleanup after coordinator SIGTERM and SIGKILL, without model calls
- Independent review and executable checks of stop/start, cleanup/resume, and shutdown/socket races

Not verified on macOS, Windows, or network filesystems. The package is Linux-only because safe process identity uses `/proc`. No dashboard, workflow DSL, daemon, or automatic merging is included.

## License

[MIT](LICENSE). No third-party extension implementation was copied. Pi and TypeBox remain peer dependencies; exit-guard prior art and license findings are recorded in the implementation history.
