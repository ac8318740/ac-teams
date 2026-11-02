## Session roles: promotion, joining, and several main sessions

Status: draft for review. Implements nothing yet. Resolves the design questions in [issue #19](https://github.com/ac8318740/ac-teams/issues/19).

A team can have several **main sessions**. A main session is a Pi session the user created, joined to a team, or promoted. Every other team process is a **member**. The user can promote a member to a main session from the TUI, or join an existing session to a team with `/teams join`. ac-teams marks every member process with `ACSTACK_AGENT_ROLE=member`, so ACStack's large-read guard applies only to main sessions.

### Review questions

1. Does promotion by relaunch feel seamless enough, given that a promoted session moves to its own Herdr tab?
2. Does it look right that every main session can control every member and other main sessions? That matches what an unsandboxed session can already do through its shell.
3. Is the takeover after the owner exits (automatic, with a notice) the right default?
4. Are the changes and tests at the end complete enough to start implementation?

### Trade-offs to judge

- **Relaunch, not live handover.** Promotion stops the member process and reopens its transcript in a new process. The member loses its in-flight turn, but its role, sandbox, token, and environment change cleanly.
- **No coordinator daemon.** The coordinator stays inside whichever main session holds `owner.lock`. When the owner exits, members stop and the next owner resumes them automatically. The cost is a pause and at most one redone turn per busy member.
- **Wide main-session authority.** Any main session can stop work started by another. ac-teams does not try to guard against this, because an unsandboxed session can already stop processes through the shell or Herdr.

## Definitions

These five properties are independent. A change to one never changes another.

| Property | Defined by | Changes when |
|---|---|---|
| Identity | Pi session id in the transcript header | Never |
| Discovery | Where the transcript file lives | Promotion moves it to the top-level session folder |
| Membership | A member record in the team store | Join adds one; leave clears its role |
| Coordinator ownership | Holder of `owner.lock` | The owner exits and another main session takes it |
| Authority | The record's `role`: `main` or `member` | Only promotion, join, or leave, all user actions |

### What the coordinator does

The coordinator is ac-teams' in-process server. Today it runs inside Main. In this design, it runs inside whichever main session holds `owner.lock`. In practice it:

- **Runs member processes.** Starts each member's Pi, either headless or in tmux, optionally inside a Docker sandbox. It also stops and resumes members, and stops them all when its host session exits
- **Answers team tools.** Every `team_agent`, `team_task`, and `team_message` call from any session arrives over `coordinator.sock` and is applied here, so concurrent edits are serialized
- **Keeps team state.** Writes members, tasks, and messages to the team store
- **Delivers notifications.** Tells each session when new team messages arrive
- **Enforces rules.** Checks authority, depth and member limits, and sandbox grants, and brokers provider credentials for sandboxed members

This design keeps all of that. It adds role checks, connections from main sessions it did not launch, promotion, joining, leaving, and ownership takeover.

The team id stays the session id of the session that created the team, even after that session leaves or hands over ownership.

### Main-agent signal

- The coordinator sets `ACSTACK_AGENT_ROLE=member` on every member process, next to `AC_TEAMS_MEMBER`. That includes the terminal-launch script, which today only passes `AC_TEAMS_*` and `HERDR_ENV`
- A hook treats the session as main when the variable is absent or `main`, and as not main for any other value
- Anything a member starts inherits the variable and counts as not main
- Promotion and every main-session launch must remove `ACSTACK_AGENT_ROLE`, every `AC_TEAMS_*` variable, and `HERDR_ENV=0`. Tests must cover this
- ACStack reads the variable on every tool call. It detects Claude Code and Codex subagents from `agent_id` in their hook payloads instead. That detection belongs to ACStack, not ac-teams
- Role grants no permission by itself

## User flows

### Promote a member

1. The user opens a teammate from the agent selector or `/teams` and chooses **Promote to main**
2. If the member is sandboxed, a confirmation states that the session will run with the user's full access. Declining cancels
3. The coordinator stops the member, waiting for its process to exit as `stop` does today
4. The coordinator moves the transcript from `ac-teams/<team>/<member>/` to the project's top-level session folder. It removes the member's config at `~/.pi/ac-teams/agents/<id>` and sets the member's role to `main` without a parent. The member's children stay its descendants
5. The coordinator writes the session's team entry: a Pi custom entry holding the team id and member id, with no secrets
6. The coordinator relaunches `pi --session <moved file>` with a clean environment:
    - With Herdr, in a new tab in the workspace for the session's worktree, creating the workspace if needed. The tab gets focus and the session's name
    - Without Herdr, in a tmux session on a per-main-session socket that the owner's `kill-server` cannot reach. The user's screen stays attached, and ac-teams prints the reattach command
7. The new process reads its team entry, connects to the coordinator with a main-session token from the team store, and appears in `/resume`

### Join an existing session to a team

1. The user runs `/teams join` in an ordinary Pi session
2. ac-teams lists this project's teams. The user picks one
3. ac-teams refuses if the session already belongs to a team with members, or if its session id is already in the chosen team
4. The coordinator adds a member record with role `main` and writes the team entry
5. The session receives a short summary of open tasks, owners, and recent messages, with its message cursor at the latest message. It claims or creates work with the normal team tools

### Several main sessions

- Each main session holds one connection to the coordinator. The owner hosts it in-process; the others connect over `coordinator.sock`
- Every main session sits at depth 0. Any main session can launch, stop, resume, and clean up any member, and stop or resume another main session
- Stopping a main session asks it to shut down through its connection. Resuming one relaunches its transcript, as in step 6 of promotion
- Members keep today's rule: they control only their descendants and never a main session
- Tasks and messages stay shared. Ownership and revision checks still serialize concurrent edits, because one coordinator applies them all

### Leave a team

`/teams leave` returns the session's in-progress tasks to todo and clears their ownership. The member record keeps its history but loses its role, so its descendants stay under the other main sessions. The team entry records the departure, so a later `/resume` does not rejoin. Leaving is refused while the session is the only main session and members are still live.

## Recovery

- **The owner exits while another main session runs.** Before stopping members, the owner records each one's state (busy, idle, or needs input) in the team store. Today, `Coordinator.open` discards that state. A connected main session then takes `owner.lock`, opens the coordinator, and runs the resume pass below. Every main session gets a notice naming the new owner
- **No main session is running when the owner exits.** Members stay stopped with their recorded state. The next main session that opens the team runs the same resume pass
- **A promoted session is resumed with no coordinator running.** The extension reads its team entry at startup and offers to take ownership. Accepting opens the coordinator and runs the resume pass. Declining runs the session without team tools

### Resume pass

| Recorded state | Action |
|---|---|
| Busy | Resume and send: "Your process was restarted during a coordinator handover. Check your last steps and continue your current task." |
| Idle | Resume and leave idle |
| Needs input | Resume and show **Needs input** again |

Pi saves each completed message, so a busy member loses only the reply it was generating and redoes that turn. A command killed mid-run may have half finished. The message tells the member to check before it continues, which reduces that risk but does not remove it, the same as stopping a member today.
- **A main session crashes.** Its record stays. The coordinator marks it interrupted, and any main session can resume it
- **Promotion fails partway.** Each step is recorded in the team store before the next starts. On failure, the coordinator rolls back to a stopped member with its original transcript path, and the member can be retried or resumed

## Security boundaries

- Only the user can promote, join, or leave. These actions have no agent-tool form
- Promoting a sandboxed member is an explicit escalation, approved in the confirmation step. Without approval, nothing changes
- Main-session tokens live in the private team store, which sandboxed members cannot read. A member therefore cannot impersonate a main session over the socket
- Descendant non-escalation stays as it is: a member cannot grant its descendants more access than it has
- Provider credentials for sandboxed members come from the current owner's Pi login. After a takeover, the new owner brokers them under the same OS user

## Changes needed before implementation

- **Team store schema 4.** Add `role` to members and migrate `root` to a main record. Replace `actor === "root"` checks with role checks. Store each main session's token
- **Coordinator.**
    - Accept connections from main sessions that were not launched by the coordinator
    - Add promote, join, leave, and the stop and resume of main sessions
    - Add ownership takeover, and recompute descendant depths after a promotion
- **Launch environment.** Set `ACSTACK_AGENT_ROLE=member` for every member, including the terminal script's variable filter. Strip it on main-session launches
- **Extension.** Read the team entry at `session_start`. Add `/teams join`, `/teams leave`, and the **Promote to main** action. Open Herdr tabs, or use the tmux fallback
- **Docs.** Update `docs/usage.md`, `docs/operations.md`, and `docs/access.md`

## Tests needed

- A launched member has `ACSTACK_AGENT_ROLE=member`, in both RPC and terminal modes
- A promoted session's environment has no `ACSTACK_AGENT_ROLE` and no `AC_TEAMS_*` variables
- Promotion keeps the session id, moves the file, updates the stored path, and writes the team entry. Pi's session listing then includes the session
- A sandboxed promotion is refused without confirmation and runs unsandboxed after it
- Joining refuses a duplicate session id, and refuses a session that leads another team with members
- A main session can stop and resume members and other main sessions. A member cannot act on a main session
- When the owner exits, another main session takes the lock. Busy members resume with the continue message, idle members stay idle, and members that needed input show **Needs input** again
- When no main session is running, the next one to open the team runs the same resume pass
- Resuming a promoted transcript with no coordinator offers takeover, and declining leaves team tools off
- Leaving returns in-progress tasks to todo and keeps descendants manageable
- A promotion interrupted after each step rolls back to a resumable member
- Schema 3 teams migrate to schema 4 with root as a main record
