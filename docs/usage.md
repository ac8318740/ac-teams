# Use ac-teams

ac-teams provides three tools without prescribing a workflow. Your Pi session is the root; its child agents are members. The root opens coordination state on the first team request.

| Tool | Actions | Main rule |
| --- | --- | --- |
| `team_agent` | `launch`, `list`, `status`, `stop`, `resume`, `limits`, `cleanup` | A parent controls its descendants, not peers or ancestors |
| `team_task` | `create`, `list`, `read`, `edit`, `claim`, `start`, `release`, `complete`, `reopen` | Claim reserves work; dependencies gate starting, not ownership |
| `team_message` | `send`, `history`, `search` | Recipients select who receives notification, not who can read |

In interactive Pi, `/teams` or `/teams panel` opens the team panel. `/teams teammate <name-or-id>` opens a live teammate directly; autocomplete suggests subcommands and teammate names. You can also enter an exact teammate ID. The older `/teams open <id>` form remains supported. Headless roots retain the status listing. `/teams stop` stops every descendant. See [operations](operations.md) for limits, recovery, and worktree cleanup.

## Navigate without stopping members

The agent selector sits below Pi's status lines. It shows each member's name, state, model display name, and context usage. It keeps Main pinned and shows at most five rows, including an overflow indicator when needed. A finished assignment leaves its member idle and selectable.

Context shows Pi's reported token estimate, window size, and percentage, for example `Claude Opus 4.6 · 48k / 200k (24%)`. Reports refresh about once a second when they change. Unknown usage stays marked unknown, not zero. Stopped members retain their last report. These are context estimates, not billing totals.

- Press Down from an empty editor to focus Main in the footer. Up/Down select members; Enter opens the selected live session; Esc returns to editing.
- Ctrl+Shift+Left returns from a member to Main. Switching preserves the member's process, session, and draft. Returning does not stop it.
- `/teams` opens three tabs. Tab moves between Tasks, Teammates, and Activity; Esc closes the panel.
    - **Tasks:** Arrow keys select nodes in the dependency graph. G toggles graph/list, and Enter shows full details. Green means Done, red Blocked, cyan Working, and neutral Ready; written labels remain visible. Large or unsupported graphs fall back to the list.
    - **Teammates:** Enter opens a live member, or quietly resumes a stopped member's saved session before opening it. Root can open any member; member views can open their descendants.
    - **Activity:** Shows the latest 100 persistent team messages rather than every tool update. Use `team_message history` to read older messages.
- N composes a task request for Main. C on a task sends feedback to its creator. Enter sends; Shift+Enter adds a newline; Esc cancels without losing the draft. These messages do not directly edit the task graph. Feedback resumes a stopped creator when possible; otherwise, the receipt explicitly reports delivery to Main instead.

A task request is a proposal, not an instruction to create a task. Main receives guidance to review the agreed scope and existing work first: reuse a task that already covers the request, extend one when coherent and permitted, or create distinct in-scope work. It should clarify unresolved scope conflicts and explain its decision with task references.

The send receipt confirms delivery, not acceptance or task creation. This is agent guidance, not an automatic semantic duplicate detector.

Team tool results and messages are compact by default. Ctrl+O expands them into labeled fields. UI state colors do not replace the underlying progress, ownership, or dependency fields.

## Show tasks and configure the displays

The task summary sits above the input editor; the agent selector stays below the status lines. It shows completed/total counts and up to five numbered task labels, ordered by:

1. In-progress work
2. Ready prerequisites blocking other tasks, with the most dependents first
3. Blocked work, marked `⊘` with prerequisite numbers such as `blocked by #3`
4. Recently completed work, newest first

Ordinary ready tasks remain in `/teams`; the summary is not the full task list. Completion time determines recent order for newly completed tasks. Older completed tasks without timestamps fall back to task-number order.

Use `/teams config` to toggle **Task summary** and **Agent selector** independently. Up/Down select a setting; Space or Enter toggles it; Esc closes. Changes save immediately for the current and future sessions. Other running sessions are not updated automatically. Both displays default to On.

Hiding a display does not stop agents, change tasks, or disable `/teams`. With the agent selector hidden, ordinary editor Down behavior returns. These global display preferences do not change the team's resource ceilings.

## Give members bounded assignments

Example `team_agent` arguments:

```json
{"action":"launch","name":"parser-review","brief":"Review src/parser.ts. Read only; do not delegate or edit. Send findings to root through team_message."}
```

Every launch needs a unique descriptive `name`: one or two lowercase words, hyphenated if two, at most 40 characters. For example, `parser-review` or `research`. `main`, `root`, and names matching an existing member's ID are reserved. Names remain stable across stop/resume; IDs remain the API references.

`cwd` defaults to the requesting member's directory. `model` (`provider/model`) and `thinking` default to that member's current selection. An explicit override wins. Native Pi selects the model; provider/account rejections remain visible in member status and notify the parent. There is no automatic model retry.

Launch returns the name, a stable member ID, PID, cwd, and native session ID/path. Interactive roots launch native Pi terminals in a team-private tmux server; headless roots keep the RPC transport. Finishing a turn makes the member idle only after Pi reports `agent_settled`. It does not stop the process.

Children load ac-teams explicitly and otherwise keep normal Pi extensions, skills, authentication, and cwd instructions. They receive their brief, not the parent's conversation. Load ac-teams only once in the root, either through Pi package settings or an explicit extension path.

Children can delegate through the same coordinator, subject to depth and capacity. Delegation still needs user authorization. Keep briefs bounded, agree on file ownership, and use separate worktrees for concurrent writers.

## Track progress separately from ownership

Example `team_task` arguments:

```json
{"action":"create","label":"Parser review","title":"Review parser errors and malformed input","description":"Check malformed input and report concrete failures; no edits."}
```

Each task has a stable team-local `number` and a 1–3-word `label` (at most 60 characters). The graph and list show `#3 Parser review`; details retain the full title, description, and UUID.

Numbers follow creation order. Editing, filtering, or reopening tasks never changes their numbers. A concise title can supply an omitted label; longer titles need an explicit label.

Interim and final goals are ordinary tasks. Use dependencies for real prerequisites, not to make the diagram connected. Independent tasks remain disconnected until they genuinely contribute to a dependent task.

Progress and ownership remain separate:

- **Progress:** `status` is `todo`, `in_progress`, or `done`
- **Ownership:** `owner` is one member ID, or absent
- **Dependencies:** `dependencies` lists prerequisite task IDs. Returned `blockedBy` lists those not yet done; the coordinator calculates it rather than storing it as a status.

Use the returned task ID with these actions:

| Action | Effect |
| --- | --- |
| `claim` | Reserve an unowned to-do task, even if blocked. Progress stays `todo`. |
| `start` | The owner moves `todo` to `in_progress`, only when every dependency is `done`. |
| `complete` | The owner moves `in_progress` to `done`, with `acceptance: true`. Ownership remains. |
| `release` | Clear ownership. In-progress work returns to `todo`; done work stays `done`. |
| `reopen` | Explicitly move `done` to `todo`, retaining any owner. Refuse if a dependent is in progress or done. |

Only the owner can start, complete, or release its work. An ancestor may explicitly release a stopped or interrupted descendant's ownership. The owner or root can reopen an owned task; any member can reopen an unowned one. Done tasks cannot be claimed until reopened.

Include `dependencies` on creation or `edit`. Any member can edit unowned to-do work; only the owner can edit reserved to-do work. In-progress and done tasks cannot be edited. The coordinator rejects unknown dependencies and cycles. An optional `revision` rejects stale mutations.

`acceptance: true` asserts that the agent checked the acceptance criteria; it is not an independent test runner. Stop/crash retains ownership and progress. There is no automatic reassignment.

## Send messages instead of polling

Example `team_message` arguments:

```json
{"action":"send","recipients":["root"],"text":"Parser review complete. No edits; two malformed-input cases need tests."}
```

Omit `recipients` to notify all other live members. Explicit sets must contain unique live member IDs; an invalid set rejects the whole send. All team members can read the full history, including direct messages.

```json
{"action":"history","after":0,"limit":20}
```

Use the last returned `seq` as the next `after` cursor. `search` adds a case-sensitive literal `query`; results remain cursor-paged. Reads never consume messages. Task and message result pages are limited to 100 items.

New messages queue a compact Pi follow-up: an idle member wakes, while a busy member finishes its current work first. Notifications batch for 50 ms and reference history rather than copying every message into context. Notification acknowledgement means queued, not read or acted on.

Messages survive crashes; exactly-once delivery or model execution does not. Avoid acknowledgement-only replies.

## Companion tools add guidance or terminal management

ac-teams works alone. ACStack adds planning, review, and shipping skills; Herdr adds terminal tabs, panes, and visible root sessions. These are companion capabilities, not automatic integrations. ac-teams does not open a Herdr pane for each member. Interactive members use a team-private tmux server and open in the current terminal when selected; headless roots use RPC members.

Other delegation tools can coexist. ac-teams warns when `Agent`, `SubagentWorkflow`, or `subagent` is active, but does not disable them. Its limits cover only members launched through `team_agent`. Use Pi's resource settings to disable other launchers if you want one team authority. Shell access and same-user extensions are not sandboxed.

[Back to README](../README.md)
