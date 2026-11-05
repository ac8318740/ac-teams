# Expanded systems v2 candidate comparison

Updated AC Teams candidate + AC Stack 0.56.0: **2/2 problems passed; 0 teammates created**. Each arm ran both tasks concurrently in fresh projects.

| Problem | Baseline time | Candidate time | Baseline checks | Candidate checks | Candidate teammates |
| --- | ---: | ---: | ---: | ---: | ---: |
| event-delivery | 6m30s | 8m23s | 34/34 | 34/34 | 0 |
| workspace-indexer | 6m24s | 7m52s | 47/47 | 47/47 | 0 |

Times are per-problem attempts, including any wait for active descendants after the root answer. Root-only and descendant-settle times are in JSON. Candidate grading took event-delivery: 0.53s, workspace-indexer: 0.57s.

## Usage

| Arm / problem | Input | Output | Cache read | Total including cache |
| --- | ---: | ---: | ---: | ---: |
| Baseline / event-delivery | 39,880 | 13,195 | 852,608 | 905,683 |
| Baseline / workspace-indexer | 41,254 | 11,006 | 1,110,784 | 1,163,044 |
| **Baseline total** | 81,134 | 24,201 | 1,963,392 | 2,068,727 |
| Candidate / event-delivery | 47,514 | 15,215 | 1,508,224 | 1,570,953 |
| Candidate / workspace-indexer | 47,558 | 15,938 | 1,213,696 | 1,277,192 |
| **Candidate total** | 95,072 | 31,153 | 2,721,920 | 2,848,145 |

Usage includes all root/child transcripts; reasoning is already in output. Supervisor work is excluded. Subscription allowance weighting and dollar cost are unknown. Cache-inclusive totals are not equivalent to fresh input/output consumption.

## Coordination and checks

- event-delivery: 1 session(s); `team_agent` 0, `team_message` 0, `team_task` 7 calls; 0 assistant errors, 0 aborted requests.
  - No child launch: actual child extension inheritance was **not exercised**; root AC Stack implementation/test skill reads were observed.
- workspace-indexer: 1 session(s); `team_agent` 0, `team_message` 0, `team_task` 5 calls; 0 assistant errors, 0 aborted requests.
  - No child launch: actual child extension inheritance was **not exercised**; root AC Stack implementation/test skill reads were observed.

Both baseline and candidate agents worked solo. The updated delegation guidance did not trigger natural teaming in these attempts; no inter-agent coordination benefit was measured.

## Reproducibility and limits

- Candidate entry: parent `message-audit/src/index.ts`, **not** an earlier snapshot. Source freeze `ac5b1e680fe445fc0552f4d991606affe49388cf3c722a64850e33ac74b2105e`; all 31 source/package files matched before and after both runs.
- AC Stack package and both explicit extension entry fingerprints matched the baseline and stayed unchanged.
- All 38 problem/contract/reference/grader files and normalized task prompts matched the baseline. Model, effort, explicit extension set, project-worker configuration, and local launch/grading approach matched.
- Normal AC Teams settings applied; no eval-specific team-size/depth override, delegation hint, or attempt cutoff. No grader feedback, repair retry, or post-grading code changes.
- Native projects are instruction-confined, not OS-sandboxed or resource-isolated. Shared-host contention and model variance remain. One attempt per problem does not establish causal improvement or regression.

[Accepted baseline](EXPANDED-BASELINE.md) · [Safe detailed candidate results](results/expanded-v2-candidate-acstack-2026-11-05.json). Raw local attempts: `/tmp/ac-teams-small-local-20261105/runs/expanded-stack-c27-*/`.
