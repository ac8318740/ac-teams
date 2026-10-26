# ac-teams

Persistent agent teams for [Pi](https://github.com/earendil-works/pi): shared tasks, searchable messages, and optional Git worktrees. Members stay alive between assignments and can resume their native Pi sessions after stopping. No workflow engine or background service.

## Install

Requires Linux, Node 22.19 or newer, and an authenticated `pi` executable on `PATH`. Interactive teams also require `tmux` on `PATH`. Tested with Pi 1.4.0.

```sh
pi install npm:ac-teams@0.0.2
```

Restart Pi after installation. Use Pi's `/trust` command to save approval for each project directory before launching members there; headless children cannot answer the initial trust prompt.

## Use it

Your Pi session is the root; its child agents are members. Ask Pi to delegate a bounded assignment, for example:

> Launch a member to review src/parser.ts without editing, and have it send findings back to me.

| Tool | Purpose |
| --- | --- |
| `team_agent` | Launch, inspect, stop, and resume members; manage limits and worktrees |
| `team_task` | Track shared work, ownership, and dependencies |
| `team_message` | Send notifications and read or search team history |

`/teams` or `/teams panel` opens Tasks, Teammates, and Activity. `/teams teammate <name-or-id>` opens a teammate directly; subcommands and teammate names autocomplete. Use the task graph or list, send feedback, and open a member's full live Pi session.

The task summary sits above the input. The agent selector below status shows descriptive names, models, and context usage. `/teams config` toggles these displays independently.

From an empty editor, press Down to select the team footer, then Enter to open a member. Ctrl+Shift+Left returns to Main without stopping the member. `/teams stop` stops every descendant.

Defaults allow up to **10 live members** and **two levels of delegation**. Use the fewest useful agents.

## Know the boundaries

- Members share your filesystem access. All members can read all team messages, including direct messages.
- Limits cover only `team_agent`, not other delegation tools. Use separate worktrees for concurrent writers.
- Stop retains tasks, sessions, and worktrees. Worktree deletion is explicit and requires clean, integrated work.
- Exit confirmation needs Pi's `session_before_exit` hook, which installed Pi 1.4.0 lacks. Without it, shutdown cleans up but cannot ask first. Signals always bypass confirmation.

See the [operations guide](docs/operations.md) for recovery guarantees, storage, and the Pi dependency security advisory.

## Guides

- [Usage](docs/usage.md): tool actions, task rules, messages, and companion tools
- [Operations](docs/operations.md): limits, stop/resume, worktrees, and security
- [Development](docs/development.md): source setup, verification, and publishing
- [Implementation history](docs/implementation-plan.md): design decisions and prior art

## License

[MIT](LICENSE).
