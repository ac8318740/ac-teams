# Concurrent candidate trials

The frozen **0.0.27 + message-audit candidate passed both original verifiers**. Two fresh roots ran concurrently in separate native directories, Python environments, and panes. Each independently chose solo work with task-board self-planning; neither launched a teammate or fetched message history/detail.

Run date: 2026-11-05. Candidate source-tree SHA-256: `5e5cf537caaa76be3e161759719415c338451fcdb50d22d754a060a953422b97`. All 31 frozen source/package files matched the manifest before and after execution. Baseline commit and dataset pins are unchanged from [BASELINE.md](BASELINE.md).

## Observed results

| Task | Original verifier | Baseline agent time | Candidate agent time | Candidate grading | Candidate sessions |
| --- | --- | ---: | ---: | ---: | ---: |
| `build-cython-ext` | Pass, 11 cases | 6m 35s | 7m 12s | 6.0s | 1 |
| `portfolio-optimization` | Pass, 6 cases | 3m 54s | 4m 34s | 1m 16s | 1 |
| Sum across tasks | 2/2 in each arm | 10m 29s | 11m 46s | 1m 22s | 2 |

Candidate execution-request windows overlapped for **4m 33s**; the first-to-final assistant-message windows overlapped for **4m 29s**. Both transcripts contain interleaved real tool activity, not merely created tabs. The candidate suite window was **7m 29s**, from first submitted prompt through last original grade/result. Sums in the table add overlapping work and are not wall time.

**These are not causal performance comparisons.** The baseline tasks ran sequentially, while the candidate tasks ran concurrently on a shared host and subscription. CPU, memory, caches, and request scheduling were not isolated. There is one attempt per task per arm. Candidate agent durations and token use were higher in these observations; the runs demonstrate no efficiency improvement, but cannot establish a source-induced slowdown either. The shorter candidate suite wall time reflects different scheduling, not a measured code improvement.

## Natural coordination and usage

All four roots across both arms worked solo. Both candidate roots created three self-planning tasks, versus two per baseline root. That produced 14 candidate `team_task` calls and six automatic completion posts, versus 10 calls and four posts for baseline. There were no `team_agent` or `team_message` calls, inter-agent notices, or history/detail fetches. Thus the inter-agent message/history changes were not directly exercised.

| Usage | Baseline | Candidate |
| --- | ---: | ---: |
| Input tokens | 69,544 | 89,446 |
| Output tokens | 11,215 | 12,243 |
| Input + output | 80,759 | 101,689 |
| Cached input | 749,824 | 1,209,600 |
| Total including cache | 830,583 | 1,311,289 |

Reasoning is already included in output. These counts exclude supervisor/reporting usage. Existing subscription OAuth consumed plan allowance; allowance weighting, remaining allowance, and dollar cost are unknown. There were no model retries, assistant errors, or assistant aborts.

## Checks and limitations

- Both task prompts matched their baseline prompts exactly after normalizing only the task-directory path. No delegation hints, reviewer requirements, countdowns, or five-minute cutoff were added. Upstream safety ceilings remained 900/3,600 seconds.
- The model, thinking level, task-local CPython 3.13.6, initial dependency pins, original images and verifiers, and installed-state transfer matched baseline. Final graders used CPython 3.13.18 and the correct NumPy versions. No post-hoc source repair or package rebuild was performed.
- Portfolio's supplied benchmark and protected baseline source remained byte-identical to upstream. Original pytest output reported six passed cases; the pinned CTRF plugin deduplicates the three parameterized cases and reports four distinct functions, as in baseline.
- Cython's upstream reference oracle still has the recorded current-dependency regression. Both actual model attempts independently fixed compatibility and passed all 11 unchanged final tests. Controls and environment-adaptation caveats in [BASELINE.md](BASELINE.md) still apply.
- Before launch, the shared host had approximately 4.3 GiB available RAM, 6.3 GiB free swap, 16 GiB free disk, and eight logical CPUs. No supervisory review agents were added. Native model execution had instruction-only directory boundaries, not OS sandboxing or CPU/memory enforcement.
- Owned roots and grading containers exited. Both benchmark tabs remain at shells. No global configuration/package changes, commits, pushes, or unrelated cleanup were performed.

This is a custom two-task subset, not an official Terminal-Bench score. Safe metrics, transcript time boundaries, prompt hashes, grades, usage, and baseline comparisons are in `candidate-results.json`. Local raw artifacts remain under `/tmp/ac-teams-small-local-20261105/runs/parallel-c27-cython/` and `/tmp/ac-teams-small-local-20261105/runs/parallel-c27-portfolio/`. No credentials or team keys were copied into repository artifacts.
