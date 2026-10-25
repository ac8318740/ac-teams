# Operate ac-teams

ac-teams runs on Linux with Node 22.19 or newer and an authenticated `pi` executable on `PATH`. Interactive roots also require `tmux`: each team owns a private server and native member terminals. Headless roots retain RPC members. Both share your OS user's access, not a sandbox.

## Save project trust before launching

Use Pi's `/trust` command to approve each member's cwd before launching there. Children cannot complete the coordinator readiness handshake while waiting for Pi's initial trust prompt. ac-teams rejects readiness if project resources were skipped; it never auto-approves a project.

A one-run approval in the root is not a saved approval for children or new worktrees. Worktree creation copies committed content, not uncommitted project configuration. Approve the new cwd through native Pi trust before retrying a launch that could not load its project resources. A failed launch retains its created worktree and member record.

## Limits are ceilings, not staffing targets

Default: at most **10 live descendants**, counting starting, busy, idle, and stopping members. Root does not consume a slot. Default depth is **2**: root, child, grandchild. Use the fewest useful agents.

Root policy precedence, from lowest to highest:

1. Built-in defaults
2. `~/.acstack/ac-teams/config.json`
3. `.pi/ac-teams.json`, only with `--teams-project-config`
4. Explicit `--teams-limit` and `--teams-depth` flags

Config files accept only `limit` and `depth`, for example `{"limit":4,"depth":2}`. Limits must be 1–100; depth must be 0–10.

A limit above 10 requires an explicit root startup flag or interactive confirmation of a root `limits` tool request. Configuration alone cannot raise it. Lowering limits does not kill existing members; it blocks further launches until capacity fits.

For an npm-installed extension, set startup limits with:

```sh
pi --teams-limit 4 --teams-depth 1
```

Other delegation tools remain outside these limits. See [companion tools](usage.md#companion-tools-add-guidance-or-terminal-management).

## Display preferences are global

`/teams config` saves task-summary and agent-selector visibility to `~/.acstack/ac-teams/display.json`:

```json
{"tasks":true,"agents":true}
```

Only these two boolean keys are accepted; omitted keys default to `true`. Saves atomically replace a private 0600 file. A malformed or unreadable preferences file produces a warning and is not overwritten; correct or remove it before saving settings again. These preferences are separate from resource policy in `config.json` and have no project override.

## Stop and resume members

`stop` stops the member's descendants deepest-first, clears queued work, and aborts the turn. It closes the owned RPC pipe or terminates the owned native terminal. Hung processes escalate to SIGTERM and then SIGKILL, with a warning. Escalation requires a matching captured process-group identity; the coordinator refuses uncertain ownership.

This is snapshot-based cleanup, not OS containment. Detached or uncaptured descendants and identity-check races remain outside the guarantee.

`resume` needs a stopped descendant ID and a new brief. It keeps the member's descriptive name; renaming during resume is rejected. It starts a new process against the same native Pi session file. It does not reconstruct a transcript, reconnect to old stdio, or replay the previous assignment automatically. The coordinator refuses tool-driven resume if the old process is live or its identity is uncertain.

The interactive panel can instead quietly resume a saved member session without inventing a new brief. Feedback then arrives through the durable team mailbox.

Root session switching, forking, and tree traversal are blocked while members are live. A member cannot switch away from its team binding. Stop members explicitly before replacing the root session.

### Exit confirmation needs a Pi hook

Exit confirmation requires Pi's `session_before_exit` hook. The prerequisite is implemented in the separate local Pi checkout described in [the implementation history](implementation-plan.md#exit-confirmation-supported-hook-versus-package-interception), not in installed Pi 1.4.0.

With that hook, native exit asks before stopping live members; cancellation leaves them running. Without it, shutdown performs cleanup but cannot ask first. Signals bypass confirmation.

### Crash recovery is best effort

If the root crashes, closing its owned pipes and losing the coordinator connection makes ordinary RPC children shut down. Native members also monitor the authenticated coordinator connection and exit after it is lost. This passed SIGTERM and SIGKILL probes with native child and grandchild processes.

It is not a guarantee against a hung event loop, machine failure, or detached shell processes. Recovery refuses duplicate work when a previous member is still live or uncertain. Tasks keep their ownership and progress after stop or crash; there is no automatic reassignment.

## Worktree cleanup is explicit

Set `worktree: true` on launch. `base` defaults to the repository's HEAD; `target` records the branch/ref against which later cleanup must prove integration. Worktrees live under a sibling `.ac-teams-worktrees` directory. No fetch, merge, stash, or checkout of the original directory occurs.

Stopping never deletes a worktree. `cleanup` requires a stopped member, a clean tree including ignored/untracked files, and HEAD ancestry proven against the recorded target's current commit.

Missing targets, dirty work, and uncertain/squashed integration retain the tree. Cleanup never forces removal and retains the branch. Cleanups and resumes exclude each other.

## Local records contain sensitive project data

Each root session uses `~/.acstack/ac-teams/teams/<session-id>/`:

- `state.json` contains membership, policy, tasks, messages, claims, and notification cursors
- `sessions/` contains native Pi-managed member transcripts
- `owner.lock` and `coordinator.sock` coordinate the running root
- Interactive teams also own `t.sock`, the private tmux socket, and per-member terminal environment files; shutdown removes those files

New members also store their descriptive names and optional model/context reports. When an existing team opens, unnamed members receive stable, collision-free names such as `teammate-1`; their IDs and sessions do not change.

State schema 3 adds stable task numbers and short labels. Opening a schema 1 or 2 team assigns numbers in stored task order and initial labels from up to three title words. Full titles, descriptions, UUIDs, owners, creators, dependencies, and revisions remain unchanged.

Schema 1 also migrates progress: `pending` becomes `todo`, `claimed` becomes `in_progress`, and `completed` becomes `done`. Migration writes atomically and rejects invalid snapshots without replacement. Older ac-teams code cannot reopen schema 3; stop old sessions before updating.

Only the root writes state. Mutations validate a copy, flush a temporary snapshot, atomically rename it, and flush the directory before returning success. An exclusive process-identity lock prevents concurrent owners. Private team directories use 0700; state files and the authenticated Unix socket use 0600. Uncertain locks fail closed.

This is a small-team store: each mutation rewrites the snapshot, and search scans local history. There is no database, compaction, retention policy, automatic deletion, or deduplication of repeated mutation requests. Inspect state before retrying an ambiguous failed request.

Records and transcripts can contain sensitive project data. Permissions protect against other users, not agents running as the same OS user. All members can read all team messages, including direct messages.

### Pi dependency advisory

The local verification recorded on 2026-10-24 found that `npm audit` reports Pi 1.4.0's pinned `undici` dependency, including a high-severity advisory. ac-teams adds no HTTP client and cannot repair an existing host installation. The suggested npm fix downgrades Pi incompatibly; it has not been applied. Review the host dependency before deployment.

[Back to README](../README.md)
