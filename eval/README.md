# Evaluations

Two dependency-free TypeScript problems exercise implementation, integration, and recovery. The deterministic runner prepares projects and grades submissions. Model trials require a separate session controller.

## Start here

- [Run and record evaluations](running.md): commands, attempt artifacts, and execution limits.
- [Experiment reports](reports/README.md): recorded comparisons and their evidence.
- [Eval-running skill](../.agents/skills/eval-run/SKILL.md): interactive setup, including Teams-only or selected additional extensions.
- [Eval-audit skill](../.agents/skills/eval-audit/SKILL.md): investigate recorded results and propose improvements.
- [Contributor rules](AGENTS.md): preserve benchmark integrity and keep this directory organized.

From the repository root, with Node >=22.19 and Git:

```sh
node eval/run.mjs list
node eval/run.mjs check
node --test eval/run.test.mjs eval/record.test.mjs
```

These checks make no model calls. `check` verifies that starter tests pass, the starter leaves new requirements unsolved, and the reference satisfies all original checks. It removes only its own temporary projects.

## Current problems

| Problem | Working starter | Requested implementation |
| --- | --- | --- |
| [Event delivery](problems/event-delivery/PROMPT.md) | Scheduler, retry/backoff, status, and checkpoint/recovery | Topic subscriptions, per-subscriber retries, cancellation, dead-letter replay, and recovery |
| [Workspace indexer](problems/workspace-indexer/PROMPT.md) | Boolean/phrase/path search, atomic incremental batches, and snapshots | Incremental postings, ranked search, persistent updates, schema migration, and interrupted-write recovery |

Each problem contains a participant project in `fixture/`, its contract in `PROMPT.md`, a complete implementation in `reference/src/`, and deterministic component/integration checks in `grader/`. Preparation copies only the fixture and contract. Prompts do not assign roles or require delegation; solo attempts remain valid.

These expanded systems (v2) are coordination stress tests, not a representative coding benchmark. The [simple v1 archive](history/simple-v1/README.md) preserves different, smaller problems. [Terminal-Bench history](history/terminal-bench/README.md) has no active runner here. Results from different problem revisions are not directly comparable.

## Directory layout

| Path | Purpose |
| --- | --- |
| `run.mjs`, `record.mjs` | Deterministic preparation, grading, and recording |
| `*.test.mjs` | Tooling regression tests |
| `problems/` | Active contracts, fixtures, graders, and references |
| `reports/` | Experiment narratives, index, and validation manifests |
| `results/` | Sanitized machine-readable experiment evidence linked by reports |
| `history/` | Retired benchmarks and their frozen evidence |

Keep raw transcripts, submissions, controller scripts, and source freezes outside this checkout. Do not put credentials in reports or committed results. Native execution and grading run code on the host; the runner supplies no OS sandbox. See [execution limits](running.md#execution-limits) before model trials or grading unfamiliar submissions.
