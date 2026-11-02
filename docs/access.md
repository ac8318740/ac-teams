# Enforce member access

By default, members are ordinary unsandboxed Pi processes with your full user permissions. Enforced access is opt-in: ac-teams runs the member's whole Pi process, including its shell, extensions, and subprocesses, in a Docker container that sees only the directories you grant. If enforcement is unavailable, the launch fails; ac-teams never falls back to an unsandboxed member.

## Request access

`team_agent` launch accepts `access`:

```json
{ "action": "launch", "name": "reviewer", "brief": "...", "access": { "read": ["."] } }
{ "action": "launch", "name": "parser", "brief": "...", "cwd": "/repo/parser", "access": { "read": ["/repo/docs", "/repo/lib"], "write": ["."] } }
```

- Paths are directories, absolute or relative to the member's `cwd`. Write implies read. The `cwd` must be inside a grant.
- `network.allow` limits outbound destinations: `host`, or `*.host` for its subdomains, each optionally `:port`; without a port, an entry allows ports 80 and 443. `[]` allows only the model provider. Omit `allow` for any public destination. Omitting `network` keeps the requester's network access; from an unsandboxed requester that is any public destination.
- Omitting `access` inherits the requesting member's access. From an unsandboxed requester, it launches an unsandboxed member, as before.
- Members can only narrow access: a sandboxed member cannot grant a path outside its own access, give write where it has read, allow a destination its own allowlist does not, or launch or resume an unsandboxed member. Access is fixed at launch; resume keeps it.
- Refused grants: `/`, your home directory or its parents, `/tmp`, `/run`, anything under `/proc`, `/dev`, or `/sys`, and anything containing or inside `~/.pi/agent` or `~/.pi/ac-teams`. They would expose host service sockets, credentials, transcripts, or coordinator state.
- Grants must be canonical paths with no symlinks, and cannot contain commas, which Docker's mount syntax cannot escape.
- Docker resolves mount paths when a container starts, so a sandboxed writer could swap a granted path for a symlink just before another member starts. ac-teams holds each grant open from before the container is created, and after the container starts, before any member code runs, compares every mounted grant with the directory it holds; any difference removes the container. A writer of `/repo` and a reader of `/repo/src` can therefore run together. Runtime, transcript, and socket mounts are not compared this way, so none may sit strictly inside another live member's writable grant, across all teams. This protects against sandboxed members only; your own processes, Main, and unsandboxed members can change any path and are trusted.
- Sandboxed members cannot create or clean up worktrees, send user team actions (`/teams` feedback, task requests, resume), or open other members' terminals; use Main.

Before launching, check `sandbox` in `team_agent` `list` or `limits`: `{ "available": true, "backend": "docker" }`, or `available: false` with a `reason`. Every member receives `AC_TEAMS_ACCESS`: `{"enforced":true,"read":[...],"write":[...],"network":{"allow":[...]}}` (no `allow` means any public destination), or `{"enforced":false}`. `team_agent status` reports the coordinator's authoritative `access`.

## Write grants and untrusted output

A write grant lets the member change those live files, including Git metadata such as hooks and config, Pi project resources, and build scripts. Treat the result like any untrusted contribution: review changes before you run them, commit them, or start Git or Pi in those directories. Running changed code later outside the sandbox is your choice, not a sandbox escape.

## What an enforced member can reach

| Resource | Enforced member |
| --- | --- |
| Granted directories | Mounted at the same paths, read-only or read-write |
| Rest of the host filesystem | Not mounted. The container's system files come from the member image |
| Pi runtime | Read-only: the ac-teams package and these entries from your Pi agent directory: `npm`, `extensions`, `themes`, `skills`, `prompts`, `AGENTS.md`, `keybindings.json`, `acstack.json`, `models-store.json`. They run as trusted code inside the container and are not secret-free by design: the member can read your installed package code and lockfile, custom extension source, and global instructions. Keep secrets out of them. Your real `auth.json`, sessions, and caches are not mounted |
| Web search settings | A copy of your `web-search.json` (including any search API keys) with the proxy set |
| Trust decisions | A filtered `trust.json` with only the entries for the member's `cwd` and its parents |
| Settings | A copy of your Pi `settings.json`, including its package list and device ID, so do not store secrets there |
| Scratch | Private `/tmp` (512 MiB), home (256 MiB), and Pi agent directory (64 MiB), discarded at exit |
| Network | Outbound HTTP and HTTPS through the parent's proxy only (below); no direct network |
| Processes | Private process namespace; host processes are invisible |
| Team | The coordinator socket for team tools, and the member's own transcript directory |
| Environment | A fixed minimal set; host variables, including credentials, are not inherited |

Any Unix socket inside a granted directory remains reachable, so grant narrow directories.

Containers run as your user with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, `--network none`, no published ports, no restart policy, no Docker socket, and logging disabled. Before starting a container, ac-teams inspects its effective configuration and refuses to start it on any difference in network, ports, privileges, capabilities, security options, namespaces, devices, mounts, image volumes, user, limits, or restart policy. Docker reports bind sources unresolved, so symlink swaps are caught by re-resolving sources instead. It checks network and ports again after start.

## Outbound access goes through the parent's proxy

Containers have no network interface except loopback. A bridge inside the container exposes a proxy owned by the root Pi process on `127.0.0.1:3128`, and members get `HTTP_PROXY`, `HTTPS_PROXY`, their lowercase forms, `NO_PROXY` for loopback, and `NODE_USE_ENV_PROXY=1`. Pi, Node, curl, and other clients that honour these variables reach the web; ac-teams also points pi-web-access and billion-context at the proxy through their own settings. Clients that ignore proxy settings have no network at all; there is no transparent capture of other protocols.

The proxy:

- Handles HTTPS through `CONNECT` and plain HTTP requests, without following redirects; each new request is checked again
- Resolves names itself and refuses a destination if any resolved address is not global unicast: loopback, private, CGNAT (including Tailscale), link-local and cloud metadata, documentation, multicast, IPv4-mapped and translated forms, and every address of this host, even public ones. It connects to the address it checked, so DNS cannot change in between
- Applies the member's `network.allow` list, if any, but always allows the selected model provider's endpoint so Pi can run
- Is reachable only from that member's container, through its own socket
- Accepts at most 256 open connections per member, so one member cannot exhaust Main's file descriptors

A destination allowlist does not keep data private: an allowed host, including the model provider, receives whatever the member sends it.

## Model credentials

The member gets an `auth.json` with only its selected provider's current OAuth access token and expiry: no refresh token and no other providers. Main's Pi refreshes the token and rewrites the member's copy when it changes. The member can use, or leak, that token until it expires, and spend your quota with it; it cannot mint new tokens. Switching to another provider inside the member fails, because no other credential is present. A member with a `network.allow` list keeps its provider: its children and its resumes must use the same provider, so the always-allowed provider endpoint cannot widen its network access. The file is removed when the member exits; if Main's Pi is killed, it stays until that team is opened again and its orphans are cleaned up.

Supported: OAuth `anthropic` and `openai` models at their default endpoints, tested with Pi 1.4.0 and 1.5.0. Other providers, API-key credentials, or a changed credential shape fail the launch.

## Resource limits

Each member container is capped at 2 GiB of memory (no swap) and 1024 processes. ac-teams allows at most as many enforced members at once, across all teams on the host, as fit in 75% of host memory at that cap (5 on a 15 GiB host). It counts created and running member containers after creating a new one, so concurrent launches cannot both pass. This bounds the sum of container caps; it does not limit Main, unsandboxed members, or other host processes. CPU is not capped.

A new enforced member takes about 20 seconds to start, because Pi compiles TypeScript extensions into an empty cache.

## Set up Docker

Enforced access needs a running Docker daemon your user can use, and the member image for your Pi version. Using Docker means trusting the Docker daemon, which runs as root; membership in the `docker` group is equivalent to root access on the host.

When the image is missing, `team_agent list` reports the exact build command, for example:

```sh
docker build -t ac-teams-member:1.5.0-<hash> --build-arg PI_VERSION=1.5.0 -f <ac-teams>/src/sandbox.Dockerfile <ac-teams>/src
```

The image is `node:22-bookworm-slim`, pinned by digest, with bash, curl, Git, ripgrep, CA certificates, and the same Pi version as Main. Rebuild after upgrading Pi.

## Promotion drops enforcement

Promoting an enforced member to a main session relaunches it outside the container with your user's access. The panel asks for confirmation first. Members always run with `ACSTACK_AGENT_ROLE=member`; main sessions run without it and without inherited `AC_TEAMS_*` variables.

## Storage

- Coordinator state and settings: `~/.pi/ac-teams/teams/<team>/`, `~/.pi/ac-teams/config.json`, and `~/.pi/ac-teams/display.json`
- Generated member configuration (settings copy, provider access token, trust and web search copies, launch file): `~/.pi/ac-teams/agents/<member>/`, removed when the member exits
- Member transcripts: `<Main's session directory>/ac-teams/<team>/<member>/`, normally under `~/.pi/agent/sessions/<project>/`. Pi's `/resume` lists only top-level sessions, so member transcripts appear in `/teams`, not `/resume`

## Known limits

- Tools outside the mounted runtime, such as the ACStack CLI at `~/.claude/acstack/bin/acstack`, need explicit read grants for their directory and any symlink target. Grant those narrow directories, never `~/.claude`, which holds credentials.
- Interactive members run in the team's tmux pane through `docker start --attach`, on the container's own terminal.
- Linux only. [Development](development.md#enforced-access-verification) records what has been verified.

[Back to README](../README.md)
