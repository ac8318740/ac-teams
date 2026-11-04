# ac-teams

Persistent agent teams for [Pi](https://github.com/earendil-works/pi): shared tasks, searchable messages, and optional Git worktrees. Members stay alive between assignments and can resume their native Pi sessions after stopping. No workflow engine or background service.

## Install

Requires Linux, Node 22.19 or newer, and an authenticated `pi` executable on `PATH`. Interactive teams also require `tmux` on `PATH`. Tested with Pi 1.4.0 and 1.5.0.

```sh
pi install npm:ac-teams
```

Restart Pi after installation. Use Pi's `/trust` command to save approval for each project directory before launching members there; headless children cannot answer the initial trust prompt.

## Use it

Use `team_task` for substantial solo work as well as team deliverables. Agents receive guidance to plan multi-step work, start tasks before working, and complete them after verification. Simple tasks need no list.

Your Pi session is the root; its child agents are members. Ask Pi to delegate a bounded assignment, for example:

> Launch a member to review src/parser.ts without editing, and have it send findings back to me.

| Tool | Purpose |
| --- | --- |
| `team_agent` | Launch, inspect, stop, and resume members; manage limits and worktrees |
| `team_task` | Plan solo or team work, create tasks in batches, and track ownership and dependencies |
| `team_message` | Send notifications and read or search team history |

`/teams` or `/teams panel` opens Tasks, Teammates, and Board. `/teams teammate <name-or-id>` opens a teammate directly; subcommands and teammate names autocomplete. Use the task graph or list, send feedback, and open a member's full live Pi session.

The task summary sits above the input. The agent selector sits below the input, above your existing footer, and shows descriptive names, models, and context usage. ac-teams publishes a compact team status without replacing the footer or editor supplied by other extensions. `/teams config` toggles these displays independently.

From an empty editor, press Down to select the team row, then Enter to open a member. A red **Needs input** label marks a member with an open question. Ctrl+Shift+Left returns to Main without stopping the member or dismissing its question. `/teams stop` stops every member; main sessions keep running. `/teams join` and `/teams leave` add this session to another team or take it out.

Defaults allow up to **10 live members** and **two levels of delegation**. Use the fewest useful agents.

## Know the boundaries

- Members share your filesystem access unless launched with [enforced access](docs/access.md), an opt-in Docker sandbox that needs Docker and a locally built member image. All members can read all team messages, including direct messages.
- Limits cover only `team_agent`, not other delegation tools. Use separate worktrees for concurrent writers.
- Stop retains tasks, sessions, and worktrees. Worktree deletion is explicit and requires clean, integrated work.
- Exit confirmation needs Pi's `session_before_exit` hook, which installed Pi 1.4.0 lacks. Without it, shutdown cleans up but cannot ask first. Signals always bypass confirmation.

See the [operations guide](docs/operations.md) for recovery guarantees, storage, and the Pi dependency security advisory.

## Guides

- [Usage](docs/usage.md): tool actions, task rules, messages, and companion tools
- [Operations](docs/operations.md): limits, stop/resume, worktrees, and security
- [Enforced access](docs/access.md): Docker-enforced read/write grants, outbound proxy and destination policy, and setup
- [Development](docs/development.md): source setup, verification, and publishing
- [Implementation history](docs/implementation-plan.md): design decisions and prior art

## License

[MIT](LICENSE).
