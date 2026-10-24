# Use ac-teams

ac-teams provides three tools without prescribing a workflow. Your Pi session is the root; its child agents are members. The root opens coordination state on the first team request.

| Tool | Actions | Main rule |
| --- | --- | --- |
| `team_agent` | `launch`, `list`, `status`, `stop`, `resume`, `limits`, `cleanup` | A parent controls its descendants, not peers or ancestors |
| `team_task` | `create`, `list`, `read`, `edit`, `claim`, `start`, `release`, `complete`, `reopen` | Claim reserves work; dependencies gate starting, not ownership |
| `team_message` | `send`, `history`, `search` | Recipients select who receives notification, not who can read |

`/teams` shows member status and native session/worktree locations. `/teams stop` stops every descendant. See [operations](operations.md) for limits, recovery, and worktree cleanup.

## Give members bounded assignments

Example `team_agent` arguments:

```json
{"action":"launch","brief":"Review src/parser.ts. Read only; do not delegate or edit. Send findings to root through team_message."}
```

`cwd` defaults to the requesting member's directory. `model` (`provider/model`) and `thinking` default to that member's current selection. An explicit override wins. Native Pi selects the model; provider/account rejections remain visible in member status and notify the parent. There is no automatic model retry.

Launch returns a stable member ID, PID, cwd, and native session ID/path. Finishing a turn makes the member idle only after Pi reports `agent_settled`. It does not stop the process.

Children load ac-teams explicitly and otherwise keep normal Pi extensions, skills, authentication, and cwd instructions. They receive their brief, not the parent's conversation. Load ac-teams only once in the root, either through Pi package settings or an explicit extension path.

Children can delegate through the same coordinator, subject to depth and capacity. Delegation still needs user authorization. Keep briefs bounded, agree on file ownership, and use separate worktrees for concurrent writers.

## Track progress separately from ownership

Example `team_task` arguments:

```json
{"action":"create","title":"Review parser errors","description":"Check malformed input and report concrete failures; no edits."}
```

Each task has three independent parts:

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

ac-teams works alone. ACStack adds planning, review, and shipping skills; Herdr adds terminal tabs, panes, and visible root sessions. These are companion capabilities, not automatic integrations. ac-teams members run headlessly; Herdr does not automatically open a pane for each member.

Other delegation tools can coexist. ac-teams warns when `Agent`, `SubagentWorkflow`, or `subagent` is active, but does not disable them. Its limits cover only members launched through `team_agent`. Use Pi's resource settings to disable other launchers if you want one team authority. Shell access and same-user extensions are not sandboxed.

[Back to README](../README.md)
