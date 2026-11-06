# Develop and publish ac-teams

Source setup is for contributors. For normal use, [install the npm package through Pi](../README.md#install). See [source responsibilities and ownership](architecture.md) before changing module boundaries.

## Run from source

Requirements: Linux, Node 22.19 or newer, and an authenticated `pi` executable on `PATH`. Interactive teams also need `tmux`. From a clone of this repository:

```sh
npm ci
pi -e "$PWD/src/index.ts"
```

To work in another project, launch Pi there with the absolute path to `ac-teams/src/index.ts`. Load the extension once, either explicitly or through Pi package settings, not both. Save native Pi trust for each member's cwd as described in [operations](operations.md#save-project-trust-before-launching).

## Run local checks

```sh
npm run check
node --test eval/run.test.mjs eval/record.test.mjs
npm pack --dry-run
```

Run the full application suite with an empty temporary home and no fixed Pi agent directory:

```sh
(
    test_home=$(mktemp -d)
    trap 'rm -rf -- "$test_home"' EXIT
    env -u PI_CODING_AGENT_DIR HOME="$test_home" npm test
)
```

Isolation prevents installed user policy and extension settings from changing fixture behavior. Leave `PI_CODING_AGENT_DIR` unset: Docker credential fixtures select their own agent directories, and a fixed override breaks those checks. Enforced-access tests need a usable Docker daemon and the matching [member image](access.md#set-up-docker); unavailable Docker coverage must be reported as skipped. These containers use no host networking or published ports.

For a focused check, replace `npm test` in that block with, for example, `node --experimental-strip-types --test test/store.test.ts test/task-state.test.ts`. Tests are organized by behavior under `test/`, without a line cap; source files use the [soft 300-line target](architecture.md#use-file-size-as-a-review-prompt).

The deterministic suite makes no model calls. The evaluation-tool tests check the runner and recorder without rerunning benchmarks. Application coverage includes:

- Task reservations, progress, dependencies, release/reopen rules, and durable migration
- Subprocesses, sockets, notification batching, shutdown escalation, worktree safety, and lifecycle races
- Graph navigation, task numbers and labels, UUID references, task summaries, display toggles, state colors, and narrow layouts
- Draft retention, quiet resume, shutdown-time feedback, and maximum-length messages
- Name validation and recovery, autocomplete, name/ID resolution, and model/context reports

### Recorded native Pi verification

Additional local checks on 2026-10-24, using Pi 1.4.0 unless noted:

- Native Pi busy follow-up, idle wake with the same PID, and resume with the same session ID/path and a new PID
- Normal project-extension loading and a 10-call model smoke using the existing default model; Pi reported an estimated $0.0861
- Actual ac-teams exit confirmation, cancel/retry, and child cleanup in a real terminal using patched Pi and a model-free RPC child fixture
- Native child/grandchild cleanup after coordinator SIGTERM and SIGKILL, without model calls
- Independent review and executable checks of stop/start, cleanup/resume, and shutdown/socket races

Terminal UI checks used real native Pi processes in an isolated full-size Herdr tab with a local deterministic model endpoint, not a paid provider:

- Private tmux transport, native child/grandchild delegation, member-to-descendant switching, and single-key return to Main
- Same PID across switching, unsent member draft retention, and a new PID with the same session ID/path after quiet resume
- Real UUID task graphs, green/cyan/red state borders, and creator-directed feedback without direct task mutation
- Root exit stopping native descendants and retaining task, message, and session records
- Task summary above the input, agent selector below status, native subcommand/name autocomplete, and same-PID/session opening by name or ID
- Pi-reported model display names and changing context estimates in the live selector

### Enforced access verification

Checks on 2026-11-02, Ubuntu 24.04, kernel 6.8, Docker 29.9.2 (rootful, default AppArmor and seccomp), Pi 1.4.0, member image `ac-teams-member:1.4.0-<hash>`:

- `test/sandbox.test.ts` with real containers for RPC and native (tmux) members: grants enforced read-only and read-write; host files, other transcripts, team state, the real `auth.json`, the Docker socket, and the tmux socket unreachable; only the selected provider's access token is present, without a refresh token, and a token change reaches the container in place; public HTTP and HTTPS work through the proxy with curl and Node; this host's addresses (including its public IP and Tailscale address), the Docker bridge, and cloud metadata are refused; no direct network, UDP, or host Unix socket; the start gate cannot be replayed; no capabilities, `NoNewPrivs`, private PIDs, read-only root, written files owned by the user; nested narrower launch works and escalation is refused; the native member's terminal is the container's own pty, and TIOCSTI did not inject; containers and member credentials are removed on close
- A grant swapped for a symlink between the checks and start is caught before any member code runs, and the container is removed; a writer of a repo and a reader of its subdirectory run together; resume gets a new gated container
- A refused second owner leaves live containers alone; after the coordinator is killed, the next owner removes the orphaned container; the enforced-member cap counts other teams' containers
- A real OpenAI OAuth member with the full installed extension set (billion-context active, ACStack, pi-web-access) answered through the proxy, ran curl (200), `web_search`, and `fetch_content` on a public documentation page; a member with `network.allow: []` still reached the model while curl to a public site failed; no refresh token or other provider in the container; network `none`, no ports, and no host listener changes

Anthropic, later on 2026-11-02 (Pi 1.4.0 for the first two checks; Pi 1.5.0 with member image `ac-teams-member:1.5.0-<hash>` for the third and for a full `npm test` rerun, 118 pass):

- A `claude-haiku-4-5` member with the full installed extension set ran curl (200), `web_search`, and `fetch_content`; with `network.allow: []` it still reached the model while curl failed; no refresh token or other provider in the container; network `none`, no ports
- A real Pi Main loading this branch from an isolated agent directory (access tokens only, no refresh tokens) launched an enforced Anthropic member with `network.allow: []` through Main's own credential code: the sandbox was available, the launch succeeded, and the member answered `curl=000`; no host listener changes and no leftover containers or member files

On the final tree with Pi 1.5.0, the OpenAI full-extension and `network.allow: []` runs passed again: curl 200, `web_search` and `fetch_content` ok, then curl `000` with the model still reachable. `npm test` passed 119 tests, and the Docker suite passed 10.

Not verified: an Anthropic Main session, because Main's own Anthropic request was refused as out of extra usage while the member's Haiku requests succeeded.

Not verified on macOS, Windows, or network filesystems. The package is Linux-only because safe process identity uses `/proc`. No web dashboard, workflow DSL, daemon, or automatic merging is included.

## Stage releases for npm approval

[The GitHub workflow](https://github.com/ac8318740/ac-teams/actions/workflows/publish-npm.yml) automatically stages a release when `package.json` reaches `main`. Changes to the workflow itself also trigger staging, so installing this automation stages the current version. It runs typecheck, tests, and package checks first.

This follows ACStack's automatic staged-release approach. Final publication still requires approval on npm with 2FA; merging alone does not make the version public.

Only `main` can stage releases. The workflow rejects other branches and tags before checkout. The GitHub environment `npm` also restricts deployments to the branch `main`, with no allowed tags.

Store `NPM_TOKEN` only in that environment, not as a repository secret. This keeps older workflows on other branches from accessing it. Set it using an interactive prompt, not a token pasted into a command or chat:

```sh
gh secret set NPM_TOKEN --repo ac8318740/ac-teams --env npm
```

Reuse acstack's token only if its permissions allow creating and staging `ac-teams`. GitHub cannot reveal the existing secret value. Otherwise, create a granular npm token with stage-publish access. npm requires 2FA on the publishing account.

For a retry without another commit, run the workflow manually from `main` in GitHub Actions or dispatch it:

```sh
gh workflow run publish-npm.yml --repo ac8318740/ac-teams --ref main
```

Pushes to other branches, tags, and pull requests do not trigger staging. An already published version is a no-op. Like ACStack, the workflow treats npm's `Version uniqueness check failed unexpectedly` response as an apparent existing staged submission and directs you to approve it. Other staging errors fail the run.

Review and approve the staged version in npm's **Staged Packages** tab using 2FA. The first staging of a new name creates a public `0.0.0-stage` placeholder. The requested version and its contents become public only after approval. See [npm's staged publishing documentation](https://docs.npmjs.com/staged-publishing/).

After approval, install through Pi, replacing the version below for later releases:

```sh
pi install npm:ac-teams@0.0.2
```

## License and prior art

[MIT](../LICENSE). No third-party extension implementation was copied. Pi and TypeBox remain peer dependencies; `grok-mermaid` is a runtime dependency for terminal diagrams. The [implementation history](implementation-plan.md) records design decisions, exit-guard prior art, and license findings.

[Back to README](../README.md)
