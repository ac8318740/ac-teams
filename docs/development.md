# Develop and publish ac-teams

Source setup is for contributors. For normal use, [install the npm package through Pi](../README.md#install).

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
npm test
npm pack --dry-run
```

The deterministic suite makes no model calls. It covers:

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

Not verified on macOS, Windows, or network filesystems. The package is Linux-only because safe process identity uses `/proc`. No web dashboard, workflow DSL, daemon, or automatic merging is included.

## Stage releases for npm approval

[The GitHub workflow](https://github.com/ac8318740/ac-teams/actions/workflows/publish-npm.yml) runs typecheck, tests, and package checks, then stages the package for approval. It follows acstack's staged-release approach and does not publish the release directly.

Only `main` can stage releases. The workflow rejects other branches and tags before checkout. The GitHub environment `npm` also restricts deployments to the branch `main`, with no allowed tags.

Store `NPM_TOKEN` only in that environment, not as a repository secret. This keeps older workflows on other branches from accessing it. Set it using an interactive prompt, not a token pasted into a command or chat:

```sh
gh secret set NPM_TOKEN --repo ac8318740/ac-teams --env npm
```

Reuse acstack's token only if its permissions allow creating and staging `ac-teams`. GitHub cannot reveal the existing secret value. Otherwise, create a granular npm token with stage-publish access. npm requires 2FA on the publishing account.

Run the workflow manually from `main` in GitHub Actions or dispatch it:

```sh
gh workflow run publish-npm.yml --repo ac8318740/ac-teams --ref main
```

Pushes and tags do not trigger staging. An already published version is a no-op. If the version is already staged, approve the existing submission rather than staging it again.

Review and approve the staged version in npm's **Staged Packages** tab using 2FA. The first staging of a new name creates a public `0.0.0-stage` placeholder. The requested version and its contents become public only after approval. See [npm's staged publishing documentation](https://docs.npmjs.com/staged-publishing/).

After approval, install through Pi, replacing the version below for later releases:

```sh
pi install npm:ac-teams@0.0.2
```

## License and prior art

[MIT](../LICENSE). No third-party extension implementation was copied. Pi and TypeBox remain peer dependencies; `grok-mermaid` is a runtime dependency for terminal diagrams. The [implementation history](implementation-plan.md) records design decisions, exit-guard prior art, and license findings.

[Back to README](../README.md)
