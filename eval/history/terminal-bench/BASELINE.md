# Baseline: Cython and portfolio tasks

AC Teams **0.0.27 passed both tasks**, working solo in each. Both sessions used the task board for self-planning, but neither launched a teammate or fetched message history. This establishes completion time and quality for the selected tasks, not evidence about inter-agent coordination.

Run date: 2026-11-05. Baseline commit: `463b2001a8dc26af14faded8414465a7d8288126`. Dataset revision: `2fd12b88aafdd04a52c298e3940bcb189f9766d6`. All 31 baseline source/package files matched the pinned commit before grading. No candidate runs were performed.

## Results

| Task | Original verifier | Agent time | Grading time | Sessions | Delegated |
| --- | --- | ---: | ---: | ---: | --- |
| `build-cython-ext` | Pass, 11 cases | 6m 35s | 5.4s | 1 | No |
| `portfolio-optimization` | Pass, 6 cases | 3m 54s | 1m 13s | 1 | No |
| Total | 2/2 tasks | 10m 29s | 1m 19s | 2 | No |

The measured suite window was **12m 06s**, from first prompt submission through final grading/result writing. It includes per-trial preparation and snapshot/transfer overhead, but excludes earlier image/Python setup, a failed setup before any model request, and supervisory/reporting work. The agents had no five-minute cutoff. Upstream safety ceilings were 900 seconds for Cython and 3,600 seconds for portfolio; neither was reached.

The Cython attempt fixed removed NumPy aliases, Cython buffer compatibility, and modern dependency compatibility, then installed the package. The portfolio attempt initially missed its local performance target, removed an array-conversion bottleneck, and reran its checks. The final artifacts, not these self-reported checks, passed the original verifiers.

## Usage and coordination

| Task | Input tokens | Output tokens | Cached input tokens | Total tokens |
| --- | ---: | ---: | ---: | ---: |
| Cython | 57,915 | 7,215 | 610,048 | 675,178 |
| Portfolio | 11,629 | 4,000 | 139,776 | 155,405 |
| Total | 69,544 | 11,215 | 749,824 | 830,583 |

Input plus output was **80,759 tokens**. Cached input is counted separately above; reasoning is already included in output and must not be added again. These are provider usage records, not dollar estimates. Existing subscription OAuth consumed plan allowance; allowance weighting, remaining allowance, and dollar cost are unknown. Supervisory usage is excluded.

Each root made five `team_task` calls and generated two task-completion board posts. Neither called `team_agent` or `team_message`. There were no child sessions, history/detail fetches, assistant errors, or assistant aborts. Consequently, this baseline does not exercise the candidate's inter-agent message-summary or history-detail changes.

## Method and environment

- Model: `openai/gpt-6.1-sol`, medium thinking. Pi 1.5.0, Node 22.23.4, Docker 29.9.2.
- Fresh native host directories and task-local CPython 3.13.6 environments. Initial NumPy versions were 2.3.0 for Cython and 2.3.2 for portfolio; portfolio also received setuptools 78.1.1.
- The task-only prompt gave no delegation hints, role suggestions, mandatory review, or instructions to create team tasks. Team tools were available. Runtime ceilings were two sessions total and depth one; a solo attempt was valid.
- `/app` in task instructions mapped to the fresh task directory. The original global Python installation requirement mapped explicitly to the supplied task-local interpreter. No host/global Python installation or global Pi configuration was changed.
- After Pi exited, the runner snapshotted source and actual installed site-packages. A fresh original-image grader received both, with an alias preserving the source path. It performed no post-hoc source repair or package rebuild. CPython 3.13.18 in the graders successfully imported the submitted cp313 artifacts; NumPy version probes matched each task.
- Original `tests/test.sh` and test files were unchanged and absent from model directories. Grading retained 1 CPU and 2 GiB for Cython, 1 CPU and 4 GiB for portfolio. Portfolio's protected baseline and supplied benchmark files remained byte-identical to upstream.
- Agent execution used instruction-only directory boundaries, not a sandbox or resource enforcement. Zero-model controls overlapped early Cython execution in a 1-CPU Docker container on an eight-logical-CPU host. No isolated timing claim is made.
- Both roots exited; owned grading/control containers were removed. The single benchmark tab remains open at a shell. No commits, pushes, global installs, or unrelated-session cleanup were performed.

## Controls and qualifications

Portfolio's original oracle passed and its blank control failed as expected. Cython's blank control failed as expected. **Cython's original reference oracle failed one repository regression on the current dependency stack** (10/11 top-level tests passed; nested repository run had 17 passed and one failed). This is recorded, not hidden or repaired. The baseline independently fixed compatibility and passed all 11 unchanged final tests, demonstrating that this task remained solvable in this environment.

Portfolio's verifier log reports six passed cases, including the 5,000-, 6,000-, and 8,000-asset cases. The pinned CTRF plugin collapses the three parameterized cases into one entry and reports four distinct test functions. Both the raw CTRF summary and the six-case pytest count are retained.

The first setup attempt found that the previously saved tab had been closed. It failed before model launch, with zero model requests or tokens; a fresh no-focus benchmark tab was then created. There were no model retries.

This is a custom two-task Terminal-Bench 2.0 subset, one baseline attempt per task, **not an official score**. There is no candidate comparison or basis for a causal teamwork-performance claim.

## Artifacts

- `baseline-results.json`: safe per-task metrics, verifier counts, usage, controls, hashes, timing, and limitations.
- `plan.json` and `prompt-template.txt`: active task configuration and task-only prompt.
- `RESULTS.md`, `results.json`, and `smoke-plan.json`: unchanged earlier smoke-test history, not results for these tasks.
- Local raw artifacts: `/tmp/ac-teams-small-local-20261105/runs/natural-b27-cython-v2/` and `/tmp/ac-teams-small-local-20261105/runs/natural-b27-portfolio/`. Verifier logs, CTRF reports, prompts, transcripts, source snapshots, and installed-state snapshots remain there. Credentials and team keys were not copied into repository artifacts.
