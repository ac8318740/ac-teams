# Operate ac-teams

ac-teams runs on Linux with Node 22.19 or newer and an authenticated `pi` executable on `PATH`. Interactive roots also require `tmux`: each team owns a private server and native member terminals. Headless roots retain RPC members. Both share your OS user's access unless a member is launched with [enforced access](access.md).

## Save project trust before launching

Use Pi's `/trust` command to approve each member's cwd before launching there. Children cannot complete the coordinator readiness handshake while waiting for Pi's initial trust prompt. ac-teams rejects readiness if project resources were skipped; it never auto-approves a project.

A one-run approval in the root is not a saved approval for children or new worktrees. Worktree creation copies committed content, not uncommitted project configuration. Approve the new cwd through native Pi trust before retrying a launch that could not load its project resources. A failed launch retains its created worktree and member record.

## Limits are ceilings, not staffing targets

Default: at most **10 live descendants**, counting starting, busy, idle, and stopping members. Root does not consume a slot. Default depth is **2**: root, child, grandchild. Use the fewest useful agents.

Root policy precedence, from lowest to highest:

1. Built-in defaults
2. `~/.pi/ac-teams/config.json`
3. `.pi/ac-teams.json`, only with `--teams-project-config`
4. Explicit `--teams-limit` and `--teams-depth` flags

Config files accept `limit`, `depth`, and `workers`, for example `{"limit":4,"depth":2}`. Limits must be 1–100; depth must be 0–10. Worker extension policy is described below.

A limit above 10 requires an explicit root startup flag or interactive confirmation of a root `limits` tool request. Configuration alone cannot raise it. Lowering limits does not kill existing members; it blocks further launches until capacity fits.

For an npm-installed extension, set startup limits with:

```sh
pi --teams-limit 4 --teams-depth 1
```

Other delegation tools remain outside these limits. See [companion tools](usage.md#companion-tools-add-guidance-or-terminal-management).

### Check headroom before adding concurrency

`team_agent list` and `limits` include a fresh `resources` advisory. Launch and teammate resume results include the sample taken before startup.

It reports host available RAM, occupied swap, recent memory stalls, and live/starting member counts. Values are bytes; Linux pressure averages are percentages.

`someAvg10` and `fullAvg10` cover ten-second trends; `fullAvg60` covers a sixty-second trend. Missing or invalid metrics are `null` with a warning, not zero or an all-clear.

The check reads only `/proc/meminfo` and `/proc/pressure/memory` on demand. It adds no polling, process-tree scans, or subprocesses.

Available RAM below 10% triggers a low-headroom warning (a heuristic, not a per-member budget). Low headroom alone does not prescribe sequential work.

Memory contention warns when `fullAvg60 >= 5` or `fullAvg10 >= 10`. Full pressure measures time when all non-idle work is stalled on memory. Partial pressure (`someAvg10`) remains informational; occupied swap alone does not trigger a pressure warning.

These thresholds are advisory defaults, not measured limits for optimal concurrency. Consider reducing concurrency if contention is slowing progress.

Starting members reserve count slots synchronously, but may not yet consume their full memory. Concurrent launch results warn about earlier starts.

Choose concurrency using resource readings and observed progress. These advisories never block a launch, change the configured ceiling, reserve RAM, or stop a member. Host figures do not account for a tighter container/cgroup limit or guarantee future capacity; other teams and non-team processes also consume resources.

Idle members keep Pi and its extensions alive. When a member without live children goes idle, its parent gets a post saying whether it is waiting on a watched task and asking it to stop the member unless more work is due within a couple of minutes. As a failsafe, the coordinator stops members that stay idle for five minutes without live children.

This preserves transcripts, tasks, messages, and worktrees. Extension-owned language servers and scanners can dominate memory. Choose smaller worker extension presets before startup; ac-teams does not manage an extension's own processes or share its indexes.

### Configure lean workers without adding extensions

Every worker starts a separate native Pi process. Its extensions are a subset of the running parent's **actually loaded** extensions, plus the required ac-teams coordination extension. An extension merely installed on disk, enabled in settings, or present in the child's cwd does not grant permission to load it.

Nested delegation can only narrow the set.

Run `/teams config` to start a conversation with Pi. No editor or configuration wizard opens. Pi reads the current policy and extension inventory through `team_config`, asks what workers need, and proposes settings in plain language. It can use an available question tool or ask in chat.

Pi asks where to save (user defaults, or trusted project overrides when enabled), helps choose a default and presets, and asks which safety/provider/auth extensions every worker must retain. It does not infer dependencies or classify plugins by name. Initially, `worker` selects the parent's loaded extensions, `full` keeps all of them, and `minimal` selects none. Required extensions are always added.

An optional `heapMb` sets V8's old-space allowance (128..6144 MB). This is not an RSS limit. Trial a value on representative work before adopting it.

Pi summarizes the proposal and asks for approval, then uses `team_config` to validate and save it. A final confirmation shows the exact policy. Cancelling that confirmation leaves files unchanged. You never need to edit a file.

Coordination is always injected from the running ac-teams copy. Required extensions are added to every preset, inherited by descendants, and cannot be excluded. A smaller preset removes the tools and checks supplied by its omitted extensions; keep a suitably equipped coordinator or verifier.

The configuration tool returns user and effective policy, source files, and extension IDs with provenance without importing candidate extension factories. Pi is instructed to preserve existing settings unless you ask to change them; reviewing inventory alone saves nothing. User defaults live in `~/.pi/ac-teams/config.json` under `workers`. Trusted project overrides live in `.pi/ac-teams.json` and also require `--teams-project-config`.

Project presets override user presets by name; required lists are combined, never weakened.

Example policy (replace the extension IDs with those shown by your inventory):

```json
{
  "workers": {
    "defaultPreset": "worker",
    "required": ["user:extensions/safety.ts"],
    "presets": {
      "worker": {"extensions": [], "heapMb": 1536},
      "full": {"extensions": "all"},
      "minimal": {"extensions": []}
    }
  }
}
```

Launch overrides use exact IDs, for example `extensions: {preset: "worker", include: ["user:extensions/helper.ts"]}`. `exclude` removes optional IDs. `include` can restore only an extension available in that parent, never a child-cwd or installed-but-unloaded extension.

A missing preset or required extension fails rather than silently loading everything.

Without configuration, workers retain the seedable parent set and receive a configuration nudge. This deliberately replaces unrestricted native child discovery: changing cwd must not expand the parent's extension set. Saved older members without a selection use this parent ceiling on their next launch.

`/teams config` is rerunnable. Added entries, version changes, and ordinary edits within a package change its inventory fingerprint and trigger one nudge per distinct inventory per coordinator. Preset definitions are never rewritten automatically.

New launches using `all` can include newly **parent-loaded** extensions; explicit ID lists cannot. Launch/status records report selected, required, excluded, and unavailable IDs.

Fingerprints track package-tree file metadata, not a cryptographic integrity boundary. Standalone-file helpers, nested dependencies, and changes preserving metadata require manual review. Built-ins are inventoried when observed in the parent or explicitly named in settings.

Inline, non-file extension factories cannot be replayed in another process. In a restricted member, selected files must also be readable through its approved runtime or access mounts; selection never broadens filesystem grants.

Resume retains saved IDs and the heap choice, uses current installed code, and reports changed fingerprints. Missing optional IDs are skipped with a warning but remain recorded; missing required IDs fail. Adding a new required ID outside the pinned selection requires a new launch.

Resume cannot accept a new preset or include/exclude list. A parent that no longer has an extension loaded cannot restore it to a worker.

Loaded-set observation temporarily watches stock Pi's `DefaultResourceLoader.getExtensions` during initialization and matches this ac-teams registration. It needs no custom Pi build. Real terminal and RPC tests cover Pi 1.4.0.

This is not a dedicated extension enumeration hook: if a host version no longer exposes the actual set, worker launches fail closed instead of guessing from tools, settings, or files.

Terminal launches forward controlled heap, Pi configuration directory, analysis, and proxy-attachment settings explicitly, instead of reusing stale tmux-server values. They do not forward arbitrary per-launch environment variables. This feature does not share heaps, indexes, or language servers, estimate an optimal agent count, or promise a fixed memory saving.

### Choose pi-lens reuse or separate analysis

Teammate launches default to `analysis: "auto"`, which sets `PI_LENS_WARM_ATTACH=1` in the child. Active pi-lens can then try its existing same-workspace reuse, including providers outside this team. ac-teams does not install or enable pi-lens; without it, launch proceeds normally.

Choose `analysis: "separate"` for different environments or rules, uncertain compatibility, suspicious diagnostics, or independent analyzer state. This sets the flag to `0` without disabling checks. Different assignments alone do not require separate analyzers.

An inherited `0` remains an explicit opt-out even with `auto`. Other nonempty values besides `1` stay unchanged. Restricted members always receive `0`; the wrapper adds no sharing channels or access.

Resume keeps the member's saved preference unless overridden. Older member records default to `auto`. This choice applies to teammate startup, not live processes or main-session resume.

Launch, list, and status results include `analysis`. When this coordinator launched the member, `analysisPolicy` also reports the effective `warmAttach` value and reason. `reuse requested` does not mean attachment succeeded.

The coordinator does not persist effective startup details; after recovery they appear when the member next launches.

pi-lens owns peer selection, supported shared analysis, and fallback to local analysis. No eligible provider means ordinary local analysis, not a launch failure. An existing leader participates only if its session started with warm attach enabled.

The wrapper leaves plugin configuration, data directories, tool paths, and caches unchanged. It does not prove matching environments or rules, team-only routing, successful attachment, or memory savings. Choose `separate` when those existing pi-lens limitations matter.

### Avoid repeated work without dropping updates

The coordinator skips saves when member events leave the state unchanged or notification cursors do not advance. Real changes still use the same validated, atomic saves. Repeated model errors still deliver separate parent notifications.

The footer refreshes at the same interval without fetching message history. The panel still loads messages and complete tasks. Connected sessions cache display names until the snapshot file changes; they do not retain a second copy of the history.

## Display preferences are global

`/teams config display` saves task-summary and agent-selector visibility to `~/.pi/ac-teams/display.json`:

```json
{"tasks":true,"agents":true}
```

Only these two boolean keys are accepted; omitted keys default to `true`. Saves atomically replace a private 0600 file. A malformed or unreadable preferences file produces a warning and is not overwritten; correct or remove it before saving settings again. These preferences are separate from resource policy in `config.json` and have no project override.

## Stop and resume members

`stop` stops the member's descendants deepest-first, clears queued work, and aborts the turn. It closes the owned RPC pipe or terminates the owned native terminal. Hung processes escalate to SIGTERM and then SIGKILL, with a warning. Escalation requires a matching captured process-group identity; the coordinator refuses uncertain ownership.

This is snapshot-based cleanup, not OS containment. Detached or uncaptured descendants and identity-check races remain outside the guarantee.

`resume` needs a stopped descendant ID and a new brief. It keeps the member's descriptive name; renaming during resume is rejected. It starts a new process against the same native Pi session file. It does not reconstruct a transcript, reconnect to old stdio, or replay the previous assignment automatically. The coordinator refuses tool-driven resume if the old process is live or its identity is uncertain.

The interactive panel can instead quietly resume a saved member session without inventing a new brief. Feedback then arrives through the durable team mailbox.

A stopped member also resumes quietly when a teammate sends it a direct message, replies to its post, or posts on a task it watches. Other posts, such as task-routed posts it does not watch, wait until it resumes. If the resume fails (for example, the live-member ceiling is full), the sender gets a post saying so.

Stopping a main session ends its Pi process; an exiting coordinator hands over first. Resuming another main session relaunches it in its own terminal.

Root session switching, forking, and tree traversal are blocked while members are live. A member cannot switch away from its team binding. Stop members explicitly before replacing the root session.

### Exit confirmation needs a Pi hook

Exit confirmation requires Pi's `session_before_exit` hook. The prerequisite is implemented in the separate local Pi checkout described in [the implementation history](implementation-plan.md#exit-confirmation-supported-hook-versus-package-interception), not in installed Pi 1.4.0.

With that hook, native exit asks before stopping live members; cancellation leaves them running. Without it, shutdown performs cleanup but cannot ask first. Signals bypass confirmation.

### Coordinator handover

The main session holding `owner.lock` runs the coordinator. Before it exits it records whether each member was busy, idle, or waiting for input, then stops the members. Another connected main session takes the lock within seconds and runs the resume pass: busy members resume and are told their process restarted during a handover, idle members resume idle, and members waiting for input resume and ask again. The same pass runs when a main session opens a team with no coordinator running.

A main session that crashes is marked interrupted; any main session can resume it. Raising the member limit above 10 requires the coordinator's own session, because the confirmation prompt runs there.

### Crash recovery is best effort

If the root crashes, closing its owned pipes and losing the coordinator connection makes ordinary RPC children shut down. Native members also monitor the authenticated coordinator connection and exit after it is lost. This passed SIGTERM and SIGKILL probes with native child and grandchild processes.

It is not a guarantee against a hung event loop, machine failure, or detached shell processes. Recovery refuses duplicate work when a previous member is still live or uncertain. Tasks keep their ownership and progress after stop or crash; there is no automatic reassignment.

## Worktree cleanup is explicit

Set `worktree: true` on launch. `base` defaults to the repository's HEAD; `target` records the branch/ref against which later cleanup must prove integration. Worktrees live under a sibling `.ac-teams-worktrees` directory. No fetch, merge, stash, or checkout of the original directory occurs.

Stopping never deletes a worktree. `cleanup` requires a stopped member, a clean tree including ignored/untracked files, and HEAD ancestry proven against the recorded target's current commit.

Missing targets, dirty work, and uncertain/squashed integration retain the tree. Cleanup never forces removal and retains the branch. Cleanups and resumes exclude each other.

## Local records contain sensitive project data

Each root session uses `~/.pi/ac-teams/teams/<session-id>/`:

- `state.json` contains membership, policy, tasks, messages, claims, and notification cursors
- Member transcripts live under Main's session directory in `ac-teams/<team>/<member>/`, normally `~/.pi/agent/sessions/<project>/ac-teams/...`; Pi's `/resume` lists only top-level sessions, so use `/teams` to find them
- `owner.lock` and `coordinator.sock` coordinate the main session running the coordinator; other main sessions authenticate with tokens stored in `state.json`
- Promoted members' transcripts move to `<session folder>/` beside other top-level sessions, and their `~/.pi/ac-teams/agents/<id>` folder is removed
- Interactive teams also own `t.sock`, the private tmux socket, and per-member terminal environment files; shutdown removes those files

New members also store their descriptive names and optional model/context reports. When an existing team opens, unnamed members receive stable, collision-free names such as `teammate-1`; their IDs and sessions do not change.

State schema 3 adds stable task numbers and short labels. Opening a schema 1 or 2 team assigns numbers in stored task order and initial labels from up to three title words. Full titles, descriptions, UUIDs, owners, creators, dependencies, and revisions remain unchanged.

Schema 1 also migrates progress: `pending` becomes `todo`, `claimed` becomes `in_progress`, and `completed` becomes `done`. Migration writes atomically and rejects invalid snapshots without replacement. Older ac-teams code cannot reopen schema 3; stop old sessions before updating.

State schema 5 turns messages into board posts: each has a `summary`, optional `detail`, and an optional `task` or `replyTo`; tasks gain an optional `delegator` and `outcome` post reference, and records an optional `waiting` registration. Opening a schema 4 team keeps every message's text unchanged as its summary. Older done tasks have no outcome, and no delegation is inferred. Schema 5 state cannot be opened by older ac-teams versions.

Tasks may also store `completionDependencies` in schema 5. Its absence in existing snapshots means no additional completion prerequisites; views always return an array. `dependencies` still gates both start and finish. Both edge kinds are validated together for missing IDs, duplicate edges, self-references, and cycles. Active tasks may have unfinished completion-only prerequisites; done tasks may not. Stop older code before using completion-only edges: older versions do not enforce these gates.

State schema 4 adds a role to each record: `main` or `member`. Opening a schema 3 team makes the root record a main session and every other record a member. A record without a role has left the team. A promotion records each step, so a failure rolls the member back to a stopped member with its original transcript path.

Only the coordinator writes state. Mutations validate a copy, flush a temporary snapshot, atomically rename it, and flush the directory before returning success. An exclusive process-identity lock prevents concurrent owners. Private team directories use 0700; state files and the authenticated Unix socket use 0600. Uncertain locks fail closed.

This is a small-team store: each mutation rewrites the snapshot, and search scans local history. There is no database, compaction, retention policy, automatic deletion, or deduplication of repeated mutation requests. Inspect state before retrying an ambiguous failed request.

Records and transcripts can contain sensitive project data. Permissions protect against other users, not agents running as the same OS user. All members can read all team messages, including direct messages.

### Pi dependency advisory

The local verification recorded on 2026-10-24 found that `npm audit` reports Pi 1.4.0's pinned `undici` dependency, including a high-severity advisory. ac-teams adds no HTTP client and cannot repair an existing host installation. The suggested npm fix downgrades Pi incompatibly; it has not been applied. Review the host dependency before deployment.

[Back to README](../README.md)
