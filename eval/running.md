# Run and record evaluations

Run deterministic checks from the repository root with Node >=22.19 and Git. These commands need no model calls, package installation, or services. To run a model trial, use the [eval-run skill](../.agents/skills/eval-run/SKILL.md) to choose the extension set and confirm a compatible session controller first.

## Commands

```sh
# Discover problems and validate starters/references.
node eval/run.mjs list
node eval/run.mjs check
node eval/run.mjs check workspace-indexer

# Test runner and recorder behavior.
node --test eval/run.test.mjs eval/record.test.mjs

# Prepare a fresh participant project (does not launch an agent).
node eval/run.mjs prepare event-delivery /tmp/delivery-attempt-1

# Grade a completed project, or record a controller-managed attempt.
node eval/run.mjs grade event-delivery /tmp/delivery-attempt-1
node eval/run.mjs record /path/to/attempt-directory
```

`prepare` requires a nonexistent destination outside the AC Teams checkout, including resolved symlink paths. It copies `fixture/` and `PROMPT.md` (as `TASK.md`), then initializes a fresh Git repository with an initial commit. It copies no grader, reference, result, or AC Teams source, changes no global Git settings, and creates no commit in this checkout. Participants can run `npm test` and add tests in the prepared project without installing dependencies.

`grade` emits JSON with original visible and additional test results, TAP output, and binary `reward`. Both groups must pass for reward 1. Original visible tests run in a temporary folder within the submission and import submitted source; editing participant tests or npm scripts cannot replace them. Additional tests import the submitted public entry point directly. Each test process has a 30-second hang guard and a 2 MiB output limit, unrelated to model-attempt duration.

`check` validates starter/reference behavior in disposable projects, then removes its own temporary directory. `grade`, `record`, and `check` exit nonzero on a failed grade or validation. They do not require delegation or reward it.

## Add a problem

Create `eval/problems/<problem>/` with a lowercase hyphenated name, `PROMPT.md`, `fixture/src/`, `fixture/test/`, `reference/src/`, and `grader/`. Keep the starter dependency-free and put Node/TypeScript `*.test.ts` files directly in `fixture/test/` and `grader/`; test discovery is not recursive. Use the existing problems' public-entry-point convention. The runner discovers structured problem directories automatically; no registry or reporting-script edit is needed. Run `node eval/run.mjs check <problem>` before model trials, and add the problem to `eval/README.md`.

## Model trials need a controller

The repository runner does not launch models, send prompts, collect session lifecycle events, or shut down agents. Use an available controller whose behavior and artifact contract have been checked. Do not substitute guessed CLI flags or reconstruct missing trial metadata afterward. If no compatible controller is available, stop at deterministic checks and report that blocker.

Before each trial:

1. Freeze the source, problem revision, participant prompt, model/thinking, extension set, worker policy, and resource settings. Capture fingerprints before execution.
2. Prepare each problem in a fresh project outside the checkout. Keep controller artifacts separate from participant files. Give participants only `TASK.md` and their project, and prohibit inspecting evaluation sources, graders, references, or history elsewhere on the host.
3. Explicitly select root extensions and verify actual loading. Check child selections too; worker policy alone does not control root loading. Do not alter installed extensions or global settings to select an experiment arm.
4. Capture all root/child transcripts and exact completion timing before shutdown. Confirm every descendant has exited, then take an immutable submission snapshot and record it.

Keep prompts, starting contents, model/thinking, extension choices, and available resources equivalent across comparison arms. Do not impose eval-specific team-size/depth limits. Roughly five minutes per problem is a selection target, not a cutoff. A solo run is valid; report that coordination was not exercised. Different problems can run concurrently, but suite wall time is not a per-problem performance metric.

## Attempt artifacts

The controller must supply these files to `record`. Keep them outside this checkout, including after summarizing a trial.

| Artifact | Required contents |
| --- | --- |
| `environment.json` | Loaded extension IDs, versions, and `sha256`; runtime and model. Capture entry points, package/entry hashes, provider/thinking, Pi/Node/controller/OS versions, CPU count, and execution settings for reproducibility. No credential values or environment dumps. |
| `completion.json` | `task` problem name and `result.attempt_seconds` (finite, nonnegative), persisted before shutdown. Also preserve root/descendant timing, status, validity, source/plugin fingerprints, and recovery caveats when captured. |
| `shutdown.json` | `confirmed_exited`, backed by controller lifecycle evidence for root and descendants. Recording also checks Linux `/proc` for processes with `--session-dir` inside the attempt's sessions directory. |
| `submission/`, `submission-manifest.json` | Post-exit submission and exact path-to-SHA-256 manifest. Recording rejects changes or non-file entries. |
| `sessions/**/*.jsonl` | All participant root/child session transcripts with assistant usage. Malformed transcripts, invalid usage, or inconsistent token totals are rejected. |
| `fixture-manifest.json` (optional) | Pre-attempt problem file hashes keyed as `problems/<problem>/<relative-path>`. Recording rejects changed problems; use the attempt's matching revision. Capture this for new trials. |
| `members-safe.json` (optional) | Sanitized member metadata, including selected child extension IDs. Capture this when delegation occurs. |

Recording writes `grade.json` (full output), `record.json` (summary), and `grade-complete.json` (cached grade and grading duration). Cache identity covers the problem tree, runner, recorder, and grader function. Changing runner formatting also invalidates cache identity; re-record old trials with their matching tooling revision when retaining original grading timing matters.

Every recorded participant session contributes input, output, cache-read/write, and total tokens, plus tool/action counts. Reasoning is already included in output and is not added twice. Catalog API-equivalent estimates require complete cost data; they are not subscription charges. Supervisor usage is excluded.

Do not backfill old attempts with today's environment, timings, or fingerprints. Direct `grade` can measure correctness when metadata is missing; it cannot recover a full trial record.

## Execution limits

Native execution and grading run submitted code on the host. Withholding grader/reference files is a workflow boundary, not OS isolation. Child environment scrubbing does not prevent filesystem access or malicious code. Use disposable projects with no secrets, and do not describe native trials as sandboxed or resource-isolated. An optional member sandbox does not automatically isolate the root or grader.

Stopping a session must preserve data. Delete workspaces, transcripts, or controller artifacts only with explicit approval after confirming descendants have exited.

## Report a comparison

Add a concise report under `reports/` and sanitized aggregate evidence under `results/`, then link both from [the report index](reports/README.md). Record per problem/arm:

- Source, tooling, fixture, model, extension, and environment identities.
- Correctness, including visible and additional results.
- Prompt-to-final-answer duration, descendant settling, and separate grading duration, with any timing recovery disclosed.
- Whole-team provider usage, estimated cost when available, and actual delegation/coordination.
- Failures, missing metadata, changed conditions, and remaining uncertainty.

One attempt per cell cannot establish causal improvement or regression. Preserve original historical grades and clearly distinguish reruns against changed graders.
