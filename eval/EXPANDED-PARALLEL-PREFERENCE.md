# Expanded systems v2 parallel-preference candidate comparison

Updated AC Teams candidate + AC Stack 0.56.0: **2/2 problems passed; 3 teammates created**. Each arm ran both tasks concurrently in fresh projects.

| Problem | Baseline time | Candidate time | Baseline checks | Candidate checks | Candidate teammates |
| --- | ---: | ---: | ---: | ---: | ---: |
| event-delivery | 6m30s | 4m54s | 34/34 | 34/34 | 1 |
| workspace-indexer | 6m24s | 6m49s | 47/47 | 47/47 | 2 |

Times are per-problem attempts, including any wait for active descendants after the root answer. Root-only and descendant-settle times are in JSON. Candidate grading took event-delivery: 0.50s, workspace-indexer: 0.48s.

## Usage

| Arm / problem | Input | Output | Cache read | Total including cache |
| --- | ---: | ---: | ---: | ---: |
| Baseline / event-delivery | 39,880 | 13,195 | 852,608 | 905,683 |
| Baseline / workspace-indexer | 41,254 | 11,006 | 1,110,784 | 1,163,044 |
| **Baseline total** | 81,134 | 24,201 | 1,963,392 | 2,068,727 |
| Candidate / event-delivery | 71,426 | 15,302 | 1,224,064 | 1,310,792 |
| Candidate / workspace-indexer | 149,607 | 18,146 | 2,352,256 | 2,520,009 |
| **Candidate total** | 221,033 | 33,448 | 3,576,320 | 3,830,801 |

Usage includes all root/child transcripts; reasoning is already in output. Supervisor work is excluded. Subscription allowance weighting and dollar cost are unknown. Cache-inclusive totals are not equivalent to fresh input/output consumption.

## Coordination and checks

- event-delivery: 2 session(s); `team_agent` 2, `team_message` 3, `team_task` 8 calls; 0 assistant errors, 0 aborted requests.
  - Child `dispatch`: session present=True; both required AC Stack IDs selected=True.
- workspace-indexer: 3 session(s); `team_agent` 4, `team_message` 12, `team_task` 12 calls; 0 assistant errors, 0 aborted requests.
  - Child `persistence`: session present=True; both required AC Stack IDs selected=True.
  - Child `durability-review`: session present=True; both required AC Stack IDs selected=True.

## Reproducibility and limits

- Candidate entry: parent `message-audit/src/index.ts`, **not** an earlier snapshot. Source freeze `e6f47de08aa6dc3c65d88fd56a806b9e8b6ba165a5605d87fec623e0e53da5a3`; all 31 source/package files matched before and after both runs.
- AC Stack package and both explicit extension entry fingerprints matched the baseline and stayed unchanged.
- All 38 problem/contract/reference/grader files and normalized task prompts matched the baseline. Model, effort, explicit extension set, project-worker configuration, and local launch/grading approach matched.
- Normal AC Teams settings applied; no eval-specific team-size/depth override, delegation hint, or attempt cutoff. No grader feedback, repair retry, or post-grading code changes.
- Native projects are instruction-confined, not OS-sandboxed or resource-isolated. Shared-host contention and model variance remain. One attempt per problem does not establish causal improvement or regression.

[Accepted baseline](EXPANDED-BASELINE.md) · [Safe detailed candidate results](results/expanded-v2-parallel-preference-acstack-2026-11-05.json). Raw local attempts: `/tmp/ac-teams-small-local-20261105/runs/expanded-stack-p27-*/`.

## Previous candidate revision

The previous net-time-consideration revision stayed solo: delivery **8m23s**, indexer **7m52s**, total **2,848,145** tokens including cache. This parallel-preference revision created one delivery implementer and an indexer persistence implementer plus independent durability reviewer. Both children and roots used AC Stack; each selected worker extension set contained both required AC Stack IDs. Actual child skill reads were observed.

Compared with the accepted baseline, delivery elapsed time was **24.5% lower**, while indexer was **6.5% higher**. Correctness stayed at 34/34 and 47/47. Total usage was **3,830,801** tokens including cache versus baseline **2,068,727** and previous candidate **2,848,145**; total fresh input plus output was **254,481** versus baseline **105,335**. These are observations from single attempts, not causal estimates. Independent review is useful work, not automatically avoidable overhead.

[Prior candidate report](EXPANDED-CANDIDATE.md) remains unchanged.

## Independent review evidence

The indexer durability reviewer noticed a covered-journal append-gap issue on its initial read, but reported that the implementation had already been fixed by the time of its message. It independently reproduced the fixed case: checkpoint revision **5** plus covered journal entries **[1, 2]**, then upsert and reopen, correctly produced revision **6**. The final bounded review reported no remaining concrete findings. This is evidence of independent verification, not proof that review caused the fix or a measurable quality improvement.
