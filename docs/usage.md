# Use ac-teams

ac-teams provides three tools for planning and tracking solo and delegated work. Your Pi session is a main session; the agents it launches are members. The first main session opens coordination state on the first team request. See [main sessions](#main-sessions-share-one-team) for adding more.

| Tool | Actions | Main rule |
| --- | --- | --- |
| `team_agent` | `launch`, `list`, `status`, `stop`, `resume`, `limits`, `cleanup` | A parent controls its descendants, not peers or ancestors |
| `team_task` | `create`, `list`, `read`, `edit`, `claim`, `start`, `release`, `complete`, `reopen` | Claim reserves work; dependencies gate starting, not ownership |
| `team_message` | `send`, `history`, `search`, `wait` | Routing selects who is notified, not who can read |

In interactive Pi, `/teams` or `/teams panel` opens the team panel. `/teams teammate <name-or-id>` opens a live teammate directly; autocomplete suggests subcommands and teammate names. You can also enter an exact teammate ID. The older `/teams open <id>` form remains supported. Headless roots retain the status listing. `/teams stop` stops every member; main sessions keep running. `/teams join` and `/teams leave` change which team this session belongs to. See [operations](operations.md) for limits, recovery, and worktree cleanup.

## Navigate without stopping members

The agent selector sits below the input editor, above the existing footer. It shows each member's name, state, model display name, and context usage. It keeps Main pinned and shows at most five rows, including an overflow indicator when needed. A finished assignment leaves its member idle and selectable.

A red **Needs input** label beside a member's name marks an open question. Open that member's Pi session to answer it. Ctrl+Shift+Left returns to Main without dismissing the question.

With Herdr's Pi integration and the question adapter installed, Main reports the team's status through the shared event bus. Any open question keeps Herdr blocked; otherwise, active work keeps it working. When all members settle, it becomes idle. Members do not report directly to the shared Herdr pane.

Context shows Pi's reported token estimate, window size, and percentage, for example `Claude Opus 4.6 · 48k / 200k (24%)`. Reports refresh about once a second when they change. Unknown usage stays marked unknown, not zero. Stopped members retain their last report. These are context estimates, not billing totals.

- Press Down from an empty editor to focus Main in the agent selector. Up/Down select members; Enter opens the selected live session; Esc returns to editing.
- Ctrl+Shift+Left returns from a member to Main. Switching preserves the member's process, session, and draft. Returning does not stop it.
- `/teams` opens three tabs. Tab moves between Tasks, Teammates, and Board; Esc closes the panel. Lowercase h/j/k/l mirror Left/Down/Up/Right outside text inputs. Right opens list details; Left returns. Page Up/Down move a viewport of entries or scroll details.
    - **Tasks:** Opens as a list by default. G toggles graph/list; reopening `/teams` remembers that choice within the current Pi instance (not across reloads or restarts). Graphs are built only when displayed. Arrow keys select tasks, and Enter shows full details. **Shift+J** opens Go to task: enter a task number and press Enter to select it in either view. Invalid or missing numbers show an error; Esc cancels.
        - Small graphs show the whole map when it fits with readable titles. Dense graphs open in **Focus**, with three labeled, accent-colored sections: Prerequisites, Focused task, and Dependents. The selected box stays at the same top-left position as selection changes; resizing may move that anchor. Neighbor titles wrap, and each neighbor section shows complete boxes or an explicit remaining count. The header reports visible/total tasks. Empty sections stay labeled. Extra prerequisites remain numbered references; status and details use the complete task data.
        - In focus, Up/Down select displayed neighbors and update the neighborhood without moving the anchor; Left/Right browse all tasks, including hidden neighbors and unrelated tasks. **A** toggles focus/full map. Full maps retain spatial arrow navigation. A map that overflows says **pan to explore**, not **fit**.
        - In full maps, connected rounded bridges mark verified independent crossings. Extra wire-only rows make room for each bridge without splitting task boxes. Shared junctions, turns, ambiguous overlaps, and crossings without safe clearance stay unchanged. The legend counts rendered bridges. If route validation fails or exceeds its work limit, the original wires remain and the legend says line jumps are unavailable.
        - `-` and `+` select full-map mode and shorten or restore titles gradually (number and status always stay). **F** returns to automatic fit/focus. The selected box has a heavy border and accent text. Green means Done, red Blocked, cyan Working, and neutral Ready; written labels remain visible. Unsupported graphs and viewports too short for the anchored selected box fall back to the list.
    - **Teammates:** Shows working, idle, stopped, and needs-input counts; interrupted sessions count as needing input. Enter opens a live member, or quietly resumes a stopped member's saved session before opening it. Right opens details; Esc returns to the roster. Model, context, and directory appear above session IDs and paths. Root can open any member; member views can open their descendants.
        - Wider rosters also show Tasks (completed / currently assigned total) and the directory's final folder name. Reassigned tasks leave the previous owner's counts. Narrower views drop Directory first, then Tasks; full paths and counts remain in details.
        - Press `/` to filter names (case-insensitive). Enter applies the filter; Esc while editing clears it. Backspace edits the query. Press `/` again to edit an applied filter.
        - Shift+H hides or shows stopped members. Interrupted sessions remain visible for recovery. All members are visible by default; filters affect only this panel, not team state.
    - **Board:** Shows the latest 100 posts, one row each with sender, kind (post, reply, or outcome), summary, task, and time. The details pane shows recipients, task, summary, detail, and replies. Use `team_message history` to read older posts.
- N composes a task request for Main. C on a task sends feedback to its creator. Enter sends; Shift+Enter adds a newline; Esc cancels without losing the draft. These messages do not directly edit the task graph. Feedback resumes a stopped creator when possible; otherwise, the receipt explicitly reports delivery to Main instead.

A task request is a proposal, not an instruction to create a task. Main receives guidance to review the agreed scope and existing work first: reuse a task that already covers the request, extend one when coherent and permitted, or create distinct in-scope work. It should clarify unresolved scope conflicts and explain its decision with task references.

The send receipt confirms delivery, not acceptance or task creation. This is agent guidance, not an automatic semantic duplicate detector.

Each team tool call uses one line with a status dot, tool name, action, and result preview. Bold, colored badges such as `[todo]` separate statuses from titles and names.

The `+N lines` hint shows the hidden detail count. Ctrl+O expands the full response JSON; mouse-enabled Pi views also support clicking the row.

Tool summaries and team notification previews prefer teammate names over IDs. Message receipt IDs stay out of compact summaries. Ctrl+O expands the response, including IDs. Unknown members fall back to their IDs. UI state colors do not replace the underlying progress, ownership, or dependency fields.

## Main sessions share one team

A team can have several main sessions, each a top-level Pi session a person drives. Members are the agents they launch. Every main session controls every member and can stop or resume other main sessions; a member controls only its own descendants and never a main session.

- **Promote:** On the panel's Teammates tab, `P` stops a member and relaunches it as a main session. It keeps its session ID and history, its transcript moves to the normal Pi session folder so `/resume` lists it, and it stays in the team. Under Herdr it opens in a new tab of the workspace for its worktree; otherwise it runs in its own tmux server and ac-teams prints the attach command. A member with enforced access asks first, because the promoted session runs without the container.
- **Join:** `/teams join` lists project teams and adds this session to the chosen team as a main. It posts open tasks, owners, and recent messages. `/teams join <team-id>` selects an exact team without a picker or a UI. Both forms refuse duplicate membership or a session whose current team has other members. Explicit IDs must match a team in the same project.
- **Leave:** `/teams leave` returns this session's in-progress tasks to `todo`, clears their ownership, and drops its main-session role; its record keeps its history. The last main session cannot leave while members are live.
- **Resume:** A session remembers its team in its transcript. Resuming it reconnects to the team; if no coordinator is running, ac-teams offers to run it here. Declining turns the team tools off for this session.

One main session runs the coordinator; the others connect to it. When that session exits, another main session takes over automatically and resumes the members that were working. See [operations](operations.md#coordinator-handover).

### Handoff through Herdr

When a main Pi session successfully reads `handoff/SKILL.md` through Pi's `read` tool, ac-teams appends instructions to that tool result. This is a Pi extension hook, not an injection into Claude Code or Codex.

The installation prefix does not matter; the skill file stays unchanged. The hook skips members, sessions with team tools disabled, failed reads, and other skill reads.

The sender decides whether the receiver belongs in the same team. It considers the user's intent and whether shared tasks, messages, and team control suit the handoff. For a standalone receiver, follow the skill's normal launch instructions and agent-kind choice without joining. Only a same-team handoff uses the sender's team ID and this sequence:

1. Start a blank Pi session through Herdr in the same project, with ac-teams loaded.
2. Submit `/teams join <team-id>` to the receiver through Herdr.
3. Confirm the receiver's joined-team details (expand the result with Ctrl+O if folded) and its new main-session membership in the sender's `team_agent list`. Match the team ID and receiver session ID.
4. Only then submit the handoff prompt and follow the skill's acknowledgement steps.

A slash command need not produce a model turn, so Herdr's `prompt --wait` is not proof of joining. Inspect output and membership after a timeout or stalled response before retrying.

For a same-team handoff, stop without sending the handoff prompt if either check fails. A team-coordinator failure does not block an intentionally standalone handoff.

Reading the handoff skill opens the sender's team coordinator if needed, so there is a team to join. Task ownership does not transfer automatically; the extension adds no startup prompt or launcher.

This is agent guidance, not enforcement of arbitrary Herdr launches. Reads through shell commands do not trigger the hook.

## Show tasks and configure the displays

The task summary sits above the input editor; the agent selector sits below the editor. The task summary shows completed/total counts and up to five numbered task labels, ordered by:

1. In-progress work
2. Ready prerequisites blocking other tasks, with the most dependents first
3. Other ready work
4. Blocked work, marked `⊘` with prerequisite numbers such as `blocked by #3`
5. Recently completed work, newest first

The summary shows at most five tasks; `/teams` retains the full list. Completion time determines recent order for newly completed tasks. Older completed tasks without timestamps fall back to task-number order.

ac-teams leaves your existing footer intact and publishes a compact summary under the `ac-teams` extension-status key. Custom footers must support extension statuses to show it. In Zentui, use `/zentui extensions` to choose a placement for `ac-teams` if statuses are hidden by default. Agent navigation remains available in its own row even when the footer hides statuses.

Use `/teams config` to toggle **Task summary** and **Agent selector** independently. Up/Down select a setting; Space or Enter toggles it; Esc closes. Changes save immediately for the current and future sessions. Other running sessions are not updated automatically. Both displays default to On.

Hiding a display does not stop agents, change tasks, or disable `/teams`. With the agent selector hidden, ordinary editor Down behavior returns. These global display preferences do not change the team's resource ceilings.

## Plan solo and team work

The tool guidance asks agents to use `team_task` for substantial work with three or more steps, explicit task lists, and coordinated deliverables, including solo research, design, implementation, and verification. Single trivial tasks and conversation need no list. This is guidance, not automatic task creation or enforcement.

Before creating tasks, identify which outputs each task needs. If a task cannot start correctly without another task's verified output, record that prerequisite in `dependencies`. Keep independent work parallel, and do not add edges just to fill the graph.

Create independent tasks in one call:

```json
{"action":"create","tasks":[{"title":"Review parser behavior","description":"Acceptance: identify malformed-input failures with reproduction steps."},{"title":"Review display ordering","description":"Acceptance: compare implementation and display tests, and report mismatches."}]}
```

A batch creates 1–100 tasks atomically: invalid input leaves no tasks created. Use either `tasks` or top-level task fields, not both. Existing single-task creation remains supported. A title is enough for a simple task; description defaults to title and label defaults to its first three words, capped at 60 characters. Supply explicit acceptance criteria for substantial or delegated work.

For dependent tasks, give prerequisites unique batch-only `key` names and reference them with `@key` in `dependencies`. References can point forward or backward within the batch, alongside existing task UUIDs. Keys start with a letter, contain only letters, digits, underscores, or hyphens, and have at most 64 characters. Missing keys, duplicate keys or dependencies, self-dependencies, and cycles reject the whole batch without changing stored tasks. Keys are not stored; responses and later calls use UUIDs.

For example, API and UI implementations may both need a shared contract; integration verification may need both implementations:

```text
Shared contract ──┬──> API ──┐
                  └──> UI ───┴──> Integration verification
```

Create this graph in one call:

```json
{"action":"create","tasks":[{"key":"contract","title":"Define shared contract"},{"key":"api","title":"Implement API","dependencies":["@contract"]},{"key":"ui","title":"Implement UI","dependencies":["@contract"]},{"title":"Verify integration","dependencies":["@api","@ui"]}]}
```

Before starting or delegating, check that recorded dependencies match the outputs each task needs. Creating tasks together does not make them independent. Integration verification can start only when both implementations are done; `blockedBy` automatically lists unfinished prerequisites. Write tests before implementation when useful; that alone is not a reason to block test-writing behind implementation. Reassess dependencies when scope changes, subject to task ownership and edit rules.

Start a task before working and complete it immediately after checking the result. One agent normally works on one task at a time; teammates can work in parallel. Never complete partial work or work with unresolved failures.

Task list and mutation responses give the model compact summaries, including UUIDs, revisions, owners, and dependencies. `read` returns full descriptions and acceptance criteria. Expanded tool responses retain full records for people to inspect.

## Give members bounded assignments

Before delegating a deliverable, create or reuse a shared task and pass it as the launch `task`. The new member owns it, you become its delegator, and its posts and completion outcome reach you. Track independently owned outcomes, not every agent, tool call, or procedural step. For example:

- A fix and an independently owned test assignment need separate tasks.
- A diagnosis others need for follow-up needs a task, even if the investigation is read-only.
- A quick lookup, clarification, or brief second opinion can skip a task unless its result needs coordination or follow-up.
- Running tests as part of a fix usually belongs to the fix's existing task.

Review the current task list and relevant details first. Reuse an existing task when it covers the assignment. If none does, create one with acceptance criteria. Example `team_task` arguments:

```json
{"action":"create","label":"Parser review","title":"Review parser errors and malformed input","description":"Read-only review of src/parser.ts. Acceptance: report concrete malformed-input failures with reproduction steps, or report that none were found."}
```

Pass the returned task UUID as `task`. Example `team_agent` arguments:

```json
{"action":"launch","name":"parser-review","task":"<task-id>","brief":"Review src/parser.ts for malformed-input failures. Read only; do not delegate or edit."}
```

The launch task must be a to-do task that is unowned or yours; a failed launch returns it. ac-teams neither creates tasks automatically nor blocks launches without tasks. After delegating, do distinct work or `wait`; do not repeat the delegated work.

Every launch needs a unique descriptive `name`: one or two lowercase words, hyphenated if two, at most 40 characters. For example, `parser-review` or `research`. `main`, `root`, and names matching an existing member's ID are reserved. Names remain stable across stop/resume; IDs remain the API references.

`cwd` defaults to the requesting member's directory. `model` (`provider/model`) and `thinking` default to that member's current selection. An explicit override wins. Native Pi selects the model; provider/account rejections remain visible in member status and notify the parent. There is no automatic model retry.

Launch returns the name, a stable member ID, PID, cwd, and native session ID/path. Interactive roots launch native Pi terminals in a team-private tmux server; headless roots keep the RPC transport. Finishing a turn makes the member idle only after Pi reports `agent_settled`. It does not stop the process.

Children load ac-teams explicitly and otherwise keep normal Pi extensions, skills, authentication, and cwd instructions. They receive their brief, not the parent's conversation. Load ac-teams only once in the root, either through Pi package settings or an explicit extension path.

Children can delegate through the same coordinator, subject to depth and capacity. Delegation still needs user authorization. Keep briefs bounded, agree on file ownership, and use separate worktrees for concurrent writers.

## Track progress separately from ownership

Start ready work directly; `start` claims an unowned task and begins it atomically. Use `claim` only to reserve work in advance. Complete work after checking acceptance criteria or report blockers. Starting requires every dependency to be done.

Each task has a stable team-local `number` and a 1–3-word `label` (at most 60 characters). Compact tool summaries and the editor task summary prefer `#3 Parser review`. The panel uses task titles: lists and full maps may shorten them, while focused graphs wrap them. Details retain the full title, description, and UUID.

Numbers follow creation order. Editing, filtering, or reopening tasks never changes their numbers. An omitted label is derived from the title's first three words, capped at 60 characters. An explicit label must satisfy the same limits.

Interim and final goals are ordinary tasks. Use dependencies for real prerequisites, not to make the diagram connected. Independent tasks remain disconnected until they genuinely contribute to a dependent task.

Progress and ownership remain separate:

- **Progress:** `status` is `todo`, `in_progress`, or `done`
- **Ownership:** `owner` is one member ID, or absent
- **Dependencies:** `dependencies` lists prerequisite task IDs. Returned `blockedBy` lists those not yet done; the coordinator calculates it rather than storing it as a status.

Use the returned task ID with these actions:

| Action | Effect |
| --- | --- |
| `claim` | Reserve an unowned to-do task, even if blocked. Progress stays `todo`. |
| `start` | Claim unowned work and move `todo` to `in_progress` atomically, only when every dependency is `done`. An existing owner must be the caller. |
| `complete` | The owner moves `in_progress` to `done`, with `acceptance: true` and an outcome `summary` (optional `detail`). One atomic step records the outcome post and the done state; an identical retry returns the original. Ownership remains. |
| `release` | Clear ownership. In-progress work returns to `todo`; done work stays `done`. |
| `reopen` | Explicitly move `done` to `todo`, retaining any owner and clearing the outcome reference; the outcome post stays. Refuse if a dependent is in progress or done. |

Starting never steals another owner's work. Only the owner can complete or release its work. An ancestor may explicitly release a stopped or interrupted descendant's ownership. The owner or root can reopen an owned task; any member can reopen an unowned one. Done tasks cannot be claimed until reopened.

Include `dependencies` on creation or `edit`. Any member can edit unowned to-do work; only the owner can edit reserved to-do work. In-progress and done tasks cannot be edited. The coordinator rejects unknown dependencies and cycles. An optional `revision` rejects stale mutations.

`acceptance: true` asserts that the agent checked the acceptance criteria; it is not an independent test runner. Stop/crash retains ownership and progress. There is no automatic reassignment.

## Post to the board instead of polling

Every post has a one-line `summary` that stands alone, optional `detail`, and an existing `task` or a `replyTo` post. Example `team_message` arguments:

```json
{"action":"send","task":"<task-id>","summary":"Parser rejects empty input with a clear error; two malformed cases still crash.","detail":"Repro: ..."}
```

Use exact teammate names (such as `"oom-review"`) or member IDs in `recipients`; IDs remain valid. A post reaches its named `recipients`, the linked task's owner and delegator (the creator when there is none), the author of a replied-to post, and members waiting on that task, never the sender. A reply inherits its post's task. Posts are never broadcast: one with no recipients, task, or reply is rejected, as are unknown member IDs. All team members can read the full history.

Receipts and stored history retain resolved IDs.

```json
{"action":"history","after":0,"limit":20}
```

Use the last returned `seq` as the next `after` cursor. `search` adds a case-sensitive literal `query` over summaries and detail; results remain cursor-paged. Reads never consume posts. Task and message result pages are limited to 100 items.

Notices carry each post's summary and steer into the recipient's next safe point: an idle member wakes, a busy one sees them after its current tool batch. Read history only for detail your own work needs. A notice is acknowledged once it is persisted in the recipient's session, so a crash before that redelivers it.

`wait` with `tasks` yields: if a post is already waiting it returns at once; otherwise the turn ends without another model request, and the next post addressed to you or on those tasks starts a new one. Starting any turn clears the wait.

Messages survive crashes; exactly-once delivery or model execution does not. Avoid acknowledgement-only replies.

## Companion tools add guidance or terminal management

ac-teams works alone. ACStack adds planning, review, and shipping skills; Herdr adds terminal tabs, panes, and visible root sessions. These are companion capabilities, not automatic integrations. ac-teams does not open a Herdr pane for each member. Interactive members use a team-private tmux server and open in the current terminal when selected; headless roots use RPC members.

Other delegation tools can coexist. ac-teams warns when `Agent`, `SubagentWorkflow`, or `subagent` is active, but does not disable them. Its limits cover only members launched through `team_agent`. Use Pi's resource settings to disable other launchers if you want one team authority. Shell access and same-user extensions are not sandboxed unless a member is launched with [enforced access](access.md).

[Back to README](../README.md)
