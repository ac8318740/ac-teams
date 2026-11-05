# Coordination implementation problems

**Latest rerun:** the [persistent-notifications candidate](EXPANDED-PERSISTENT-NOTIFICATIONS.md) passed both unchanged v2 problems, with one/two teammates, in **4m48s / approximately 7m49–7m50s**. Indexer review exercised persistent watch/wait notifications. The report includes baseline/prior-candidate time and token comparisons, API-equivalent estimates, and the shutdown-only timing-recovery caveat.

**Expanded systems (v2) baseline and candidate complete:** AC Teams **0.0.27** + AC Stack **0.56.0** passed both problems in **6m30s / 6m24s**. The updated candidate, with identical AC Stack and fixtures, passed in **8m23s / 7m52s**. All four agents worked solo; natural delegation was not exercised. See [baseline results](EXPANDED-BASELINE.md) and [candidate comparison and token usage](EXPANDED-CANDIDATE.md). Installed extension fingerprints, source, prompts, and problem files were verified. Each arm ran its two attempts concurrently; one attempt per cell cannot establish causal improvement or regression. The newer [parallel-preference candidate](EXPANDED-PARALLEL-PREFERENCE.md) also passed both, in **4m54s / 6m49s**, with **one / two teammates** respectively; all required child AC Stack extensions and actual skill reads were confirmed.

The [simple v1 baseline](history/simple-v1/BASELINE.md) passed both earlier problems, in 3m13s and 3m35s, with no teammates. Its fixtures, contracts, references, graders, and results are preserved under [history/simple-v1/](history/simple-v1/README.md). Those results do not measure the expanded problems.

## Review the problems

| Problem | Working starter | Requested implementation | Contract |
| --- | --- | --- | --- |
| Event delivery | Complete v1 scheduler, retry/backoff, status, and checkpoint/recovery | Topic subscriptions, per-subscriber delivery and retries, cancellation, dead-letter replay, and integrated recovery | [Problem statement](problems/event-delivery/PROMPT.md) |
| Workspace indexer | Complete v1 Boolean/phrase/path search, atomic incremental batches, and snapshot restoration | Incremental postings, ranked search, persistent updates, schema migration, and interrupted-write recovery | [Problem statement](problems/workspace-indexer/PROMPT.md) |

Each problem is its own dependency-free TypeScript project with a public API and implementation modules. The complete v1 reference is now the working starter, and the old additional checks are visible regression tests. Participants extend a working system, not a collection of throwing placeholders. `fixture/` is the participant's project. `reference/src/` is a complete implementation; `grader/` contains new deterministic component and integration tests. All graded behavior is specified in the problem statement. No prompt assigns roles, suggests delegation, or requires teammates.

The eventual comparison is baseline AC Teams versus candidate AC Teams, with the same AC Stack version and extension set in both arms. Each problem should run in its own fresh project; different problems may run concurrently. Do not impose an eval-specific team-size/depth limit. Roughly five minutes **per problem** is a selection target, not a cutoff; the expanded systems may take longer. Their independent components and recovery paths increase implementation and integration work. The parallel-preference and persistent-notification candidates produced natural delegation in these attempts; that does not establish a general advantage. These are coordination stress tests, not a representative coding benchmark.

## Local deterministic checks

Requires Node >=22.19 and Git. No package installation, services, containers, network, or model subscription calls are needed.

```sh
# Verify both starters and both reference implementations.
node eval/run.mjs check

# Check one problem.
node eval/run.mjs check workspace-indexer

# Test the preparation/grading tooling.
node --test eval/run.test.mjs eval/record.test.mjs
```

`check` prepares disposable copies, verifies that original visible tests pass on the starter, verifies that new requirements are not already solved, then overlays the reference implementation and requires all tests to pass. It deletes only its own temporary directory. This is fixture development testing, not a model baseline trial.

Expanded-system validation:

| Problem | Starter visible | Starter additional | Reference visible | Reference additional |
| --- | ---: | ---: | ---: | ---: |
| Event delivery | 15/15 | 0/19 | 15/15 | 19/19 |
| Workspace indexer | 16/16 | 0/31 | 16/16 | 31/31 |

Both complete references pass all 81 checks. All 31 foundation checks pass on the starters; all 50 new checks fail there. Seventeen tooling tests pass, including original-test enforcement, v1 archive integrity, whole-team recording, metadata validation, cache invalidation, and active-process refusal. Repository TypeScript checking and strict checking of all current fixture/reference source pass. The [validation record and problem-file hashes](expanded-v2-validation.json) identify this revision. Historical v1 results are not v2 measurements.

## Prepare a project for later use

Preparation does **not** launch an agent:

```sh
node eval/run.mjs prepare event-delivery /tmp/delivery-attempt-1
node eval/run.mjs prepare workspace-indexer /tmp/indexer-attempt-1
```

Destinations must not exist and must be outside the AC Teams checkout. Preparation copies only the fixture and problem statement (`TASK.md`), then initializes a fresh local Git repository with an initial commit. It does not copy graders, references, historical results, or AC Teams source, and does not change global Git settings. No AC Teams repository commit is created.

Visible tests run inside the prepared project with `npm test`; dependencies are not needed. Agents may add tests. No agent launcher or model-session harness is shipped here.

## Grade a completed project

```sh
node eval/run.mjs grade event-delivery /tmp/delivery-attempt-1
node eval/run.mjs grade workspace-indexer /tmp/indexer-attempt-1
```

Grading emits JSON with separate visible/additional test results, TAP output, and `reward: 1` only when both groups pass. A failing grade exits nonzero. The runner executes original visible tests in a temporary folder inside the submission so they import the submitted source; editing submission tests or its npm command cannot replace those checks. Additional tests import the submission's public entry point directly. Component/integration test names and pass/fail counts provide diagnostic detail; there is no reward for delegation. Each deterministic test process has a 30-second hang guard, unrelated to model attempt duration.

References and graders are withheld from the prepared project **by workflow, not OS security**. Native agents on the same host could technically read other paths. Future trial instructions must prohibit inspecting evaluation sources, graders, references, or history outside their task directory. This runner is not a sandbox and does not defend against malicious submissions; grading executes submitted code on the host. Use disposable projects and no secrets. Grading child environments omit provider credentials and team credentials, but that is not filesystem isolation.

## Record a finished attempt with one command

```sh
node eval/run.mjs record /path/to/attempt-directory
```

This grades the saved submission and writes `record.json` (summary, timing, tokens, and environment) and `grade.json` (full test output). The unchanged delivery grader measured **0.47 seconds** in a local tooling test. Approximately three seconds is a grading target, not a guarantee for future, slower problems. A matching cached grade is reused; changed problem/grader code invalidates it. A failed grade exits nonzero.

The command is generic, not tied to these two problem names. It discovers structured folders under `eval/problems/`; `node eval/run.mjs list` lists them. To add another problem, provide `PROMPT.md`, `fixture/src/`, `fixture/test/`, `reference/src/`, and `grader/` with the same Node/TypeScript test conventions. Run `check <problem>` before model trials. No reporting-script changes are needed.

The local session controller supplies these files in each attempt directory:

- `environment.json`: explicitly loaded extension IDs, versions, entry points, package/entry hashes, model/provider/thinking, Pi/Node/Herdr/OS versions, CPU count, and execution settings. No credential values or environment-variable dump.
- `completion.json`: problem name and exact attempt/root/descendant timings, persisted **before** shutdown, plus captured source/plugin fingerprints.
- `shutdown.json`: confirmed process exit. On Linux, recording also checks `/proc` for remaining benchmark session processes and refuses active submissions.
- `submission/` and `submission-manifest.json`: a post-exit snapshot and its hashes. Changed snapshots are rejected.
- `sessions/**/*.jsonl`: all root/child transcripts. Every recorded session contributes input, output, cached-read/write, and total tokens. Reasoning is reported separately but not added twice. Tool/action counts are included. Optional safe member metadata records selected child extension IDs.
- `fixture-manifest.json`, when present: pre-attempt problem hashes. Changed problem files require the matching revision rather than silently grading an old attempt against new requirements.

These are controller artifacts, not participant files. The repository command does not launch models, send prompts, or shut down sessions. The local controller handles bounded idle-only exit retries and can resume post-run cleanup/recording without resending a model prompt. Old attempts missing required metadata are not silently backfilled with today's environment. Direct `grade` remains available when only correctness is needed; it cannot reconstruct missing timing or token records.

Catalog API-equivalent estimates, when complete, are not subscription invoices. Supervisor usage is excluded. Native execution is not a sandbox or resource-isolated.

## Later experiment reporting

For each problem and each version, record correctness (component and end-to-end results), prompt-to-final-answer time, separate grading time, provider input/output/cache usage across all sessions, and actual delegation/coordination. A solo attempt remains valid; record that coordination was not exercised. Keep prompts, starting contents, model/thinking, and available resources equivalent. Do not use suite wall time as a performance metric or interpret one attempt as causal evidence.

Historical Terminal-Bench reports and safe metrics remain under [history/terminal-bench/](history/terminal-bench/README.md). Their active runner and tests have been removed; they are not current problem sets.
