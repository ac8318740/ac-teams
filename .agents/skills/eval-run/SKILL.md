---
name: eval-run
description: Prepare and run repository evaluations with an approved extension set, reproducible inputs, safe session shutdown, and whole-team records. Use when asked to run evals, compare baseline and candidate trials, or prepare an evaluation run. Discover problems and available controllers; do not assume a model launcher is shipped.
---

# Run evaluations

Choose the runtime extensions with the user, freeze the trial inputs, and use the repository runner to prepare and record each attempt. Model trials require an available session controller and explicit approval of the run plan and spending. Preparation alone does not authorize a model call.

Resolve the repository root as `../../..` from this skill directory, independent of the current working directory. Run repository commands from that absolute root. Invoke with `/skill:eval-run <problems, comparison, or preparation request>`.

## 1. Ask about Teams-only execution first

The first question must be: **"Run with AC Teams only?"** Use the host's structured question tool with these single-select choices:

- **Teams only (Recommended):** AC Teams with no optional extensions. Required authentication or safety extensions must be disclosed before approval.
- **Choose extra extensions:** Discover available extensions, recommend relevant additions, and let the user choose.

Ask this before other setup questions. Do not silently reuse an earlier run's extension choice. A dismissed or unanswered question is not approval; stop and wait. Without a question tool, ask in text and wait.

Read repository instructions, `eval/README.md`, and `eval/running.md` for the current commands, artifact contract, and prerequisites. Use `eval/reports/README.md` only to locate requested historical comparisons; do not treat a historical controller path as an available executable.

## 2. Discover and approve the exact extension set

Read current runtime metadata and `team_config` with `action: "read"` when available. Distinguish actually loaded extensions, enabled/discoverable entries, installed-but-disabled entries, and editable source repositories. Inventory without importing extension factories. Do not inspect credential contents or dump environment variables. If the actual loaded set or required policy cannot be established, report that limit before proposing a runnable plan.

Separate three groups:

- AC Teams, loaded once from the exact source/package selected for the trial.
- Required authentication, provider, or safety extensions supported by current policy or documented dependencies. Do not infer requirements from names or remove required checks for a smaller run.
- Optional extensions. Recommend only additions whose observed capabilities help the requested task. Explain each recommendation briefly; never use a hardcoded package list.

For **Teams only**, select no optional entries. If required extensions prevent literal Teams-only execution, name them and explain why. Ask whether to proceed with that exact minimum set or stop. An unavailable required extension blocks the run; do not disable it or substitute silently.

For **Choose extra extensions**, use the discovered inventory in multiple selection rounds:

1. Present a short inventory distinguishing loaded/enabled entries from unavailable ones. Recommend relevant candidates first, with reasons. Keep other available entries selectable across later pages; do not narrow the choices to recommendations alone.
2. Use `multiSelect: true` and the host's option limits. Without a question tool, offer the same numbered batches in text and wait for each answer. With a 2-4-option limit, offer at most three extension candidates plus **"Skip this batch"**, meaning select none from that page. Include an explicit none/skip choice on every page. Offer one final candidate with skip when needed. Keep headers and labels within tool limits; put exact IDs and capabilities in descriptions or the preceding inventory.
3. Ask one batch per round, carry selections forward, and continue until all available candidates have been offered or the user explicitly finishes. Put a recommended candidate first and append "(Recommended)" when appropriate. Do not preselect it. Custom answers may name exact IDs or finish with no further additions; resolve ambiguous names before continuing.
4. Skip means none from that page, not clearing previous pages. If skip and candidates are selected together, ask which was intended. A dismissed batch leaves that batch unresolved; do not launch or interpret dismissal as none.
5. Summarize the resulting union. No extras across all rounds is a valid result. Unavailable entries require explicit resolution and refreshed inventory before inclusion.

Show the final exact set (IDs, versions, entry paths, required/optional status, and available fingerprints), any dependencies, and the intended root and child selections. Ask explicit single-select approval: **"Approve exact set"** or **"Revise or stop"**. A custom ambiguous response or dismissal does not approve it. Reconfirm if discovery, dependencies, or selected versions change.

### Control roots and children separately

`team_config` reports worker policy; it does not change the current root's loaded code. For an approved root, use the discovered controller's supported isolated-start configuration. Pi extension selection uses `-ne` plus explicit absolute `-e` entries, including AC Teams once. Confirm the controller can express the exact set before starting. Do not claim an already-running broader root became Teams-only after changing a worker preset.

Children can load only a subset of their actual parent's loaded extensions, plus the running AC Teams coordinator. Installed or child-cwd extensions cannot expand that set. Required policy remains in force; missing presets or required entries fail closed. Select an existing suitable worker preset or a controller-supported run-local policy; if neither can express the approved set, report the blocker. Never rewrite user/global configuration just to make a trial run.

`PI_CODING_AGENT_DIR` alone does not isolate AC Teams policy: user policy is under `~/.pi/ac-teams/config.json`; trusted project overrides use `.pi/ac-teams.json` with `--teams-project-config`. Read `docs/operations.md` for current selection and resume rules. Skills, prompts, project instructions, authentication, and analysis reuse are separate runtime inputs. Record their effective settings; extension filtering alone does not disable them. Inventory fingerprints are metadata-based and are not content-integrity proofs; capture source/package hashes separately.

## 3. Establish the controller and approve the run plan

Discover supported model-session launch and lifecycle interfaces from repository documentation and user-supplied controller references. Inspect their documented arguments and capabilities before use. Do not invent a CLI, depend on a remembered temporary script, scan unrelated private directories, or add a harness as an unrequested side task.

`eval/run.mjs` only lists, prepares, checks, grades, and records. It does not launch models, send prompts, capture completion, or stop sessions. If no supported controller is available, report **"Model trial blocked: no supported session controller found"** and offer deterministic checks or preparation only. Ask before creating projects or executing checks when those actions were not requested. Do not represent preparation as a completed trial.

Before model work, settle and show:

- Discovered problem IDs, exact task/fixture/grader revision, requested arms, repeat count, and run/artifact destinations.
- Baseline and candidate source revisions and uncommitted-file hashes. Keep unmodified integrations fixed and equivalent between arms; capture versions and hashes before the attempt.
- Identical participant prompts, model/provider/thinking, approved extensions, required instructions/checks, resources, and effective execution settings. Record intentional differences.
- Controller command/interface, completion definition, root/descendant timing, shutdown confirmation, immutable submission capture, transcript collection, and recovery without resending a prompt.
- Expected model usage/cost uncertainty and proposed concurrency. Get explicit authorization for trial count, spending, and any external execution. Separate extension approval from approval to start.

Use fresh task projects outside this checkout. Give participants only their task and prohibit inspecting eval sources, graders, references, or history outside their task directory. Do not add benchmark-specific hints, force delegation, reward team size, impose an eval-only team/depth restriction, or turn an approximate duration target into a cutoff. Preserve existing resource and safety limits.

Native Pi and grading execute with host access. Withholding references is a workflow restriction, not OS isolation; scrubbed subprocess environments do not protect filesystem secrets. Use disposable projects without secrets. Read `docs/access.md` before requesting enforced member access; it is opt-in Docker containment for members, not root or grader containment. Never silently fall back when enforcement fails. Do not start services or publish ports for these dependency-free deterministic checks.

## 4. Prepare, run, and record

Use discovered IDs and absolute paths; placeholders below must be replaced. The command reference and required artifact schema live in `eval/running.md`.

```sh
node eval/run.mjs list
node eval/run.mjs check <problem>
node eval/run.mjs prepare <problem> <new-outside-repository-project>
node eval/run.mjs grade <problem> <completed-project>
node eval/run.mjs record <attempt-directory>
```

`check` executes starter/reference code and deletes its own disposable copies. Run it before trials for the selected problem revision. `prepare` initializes a fresh Git project and does not launch an agent.

`grade` and `record` execute submitted code on the host. Untrusted submissions require explicit permission and appropriate isolation. Deterministic runner checks need no package installation or model call.

Start only the approved controller attempts, then:

1. Persist environment and input fingerprints before model execution. Keep controller records outside participant files. Preserve stdout/stderr, session IDs, and all root/child native transcripts under the attempt's `sessions/` tree without including supervisor usage.
2. Capture completion and exact attempt/root/descendant timing before shutdown. Wait for required descendants, then use the controller's supported shutdown path. A root final answer alone does not prove the team has settled.
3. Confirm processes exited, persist `shutdown.json`, then freeze `submission/` and `submission-manifest.json`. Do not fabricate an exit marker, grade a live project, or modify the snapshot after capture. If lifecycle recovery is needed, resume cleanup/recording without submitting the task again. Record interventions and uncertain timing; keep invalid or aborted attempts separate.
4. Run `record` on the attempt directory with its matching problem/grader revision. It validates persisted metadata, session usage, shutdown, and snapshot hashes; it writes `grade.json` and `record.json`, with a fingerprinted `grade-complete.json` cache. Read the JSON and exit status. A nonzero exit may mean failed correctness or a recording error; distinguish them.
5. Preserve all attempt inputs and outputs. Missing timing, environment, or transcripts cannot be reconstructed from today's settings. A direct `grade` result supplies correctness only. Do not backfill historical metadata or delete projects, sessions, snapshots, manifests, source copies, or caches as routine cleanup. Ask for explicit cleanup approval after identifying what would be lost.

## 5. Report results and limits

Report exact attempts/revisions, correctness, per-problem completion time, separate grading time, whole-team input/output/cache-read/cache-write/total tokens, and actual coordination. Reasoning is already included in output tokens; do not add it again. Catalog API estimates are not subscription charges. Identify missing child transcripts, exclusions, interventions, source drift, or timing recovery.

A solo result is valid and leaves coordination unexercised. Do not replace per-problem timings with suite wall time, combine incompatible problem revisions, or claim a causal improvement from a single attempt. Link durable reports through `eval/reports/README.md` when report writing is requested; preserve original artifacts and distinguish observations from hypotheses. For a deeper quality/time/token investigation, use the sibling `../eval-audit/SKILL.md`.

End with what ran, what passed or failed, artifact paths, and blocked or unverified work. Never describe pending trials or static preflight checks as verified model runs.
