# ac-teams

Persistent agent teams for [Pi](https://github.com/earendil-works/pi): shared tasks, searchable messages, and optional Git worktrees. Members stay alive between assignments and can resume their native Pi sessions after stopping. No workflow engine or background service.

## Install

Requires Linux, Node 22.19 or newer, and an authenticated `pi` executable on `PATH`. Tested with Pi 1.4.0.

```sh
pi install npm:ac-teams@0.0.1
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

`/teams` shows status; `/teams stop` stops every descendant. Defaults allow up to **10 live members** and **two levels of delegation**. Use the fewest useful agents.

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

[MIT](LICENSE).
