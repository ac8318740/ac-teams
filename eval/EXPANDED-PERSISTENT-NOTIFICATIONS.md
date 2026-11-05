# Expanded systems v2 persistent-notifications candidate comparison

Updated AC Teams candidate + AC Stack 0.56.0: **2/2 problems passed; 3 teammates created**. Each arm ran both tasks concurrently in fresh projects.

| Problem | Baseline time | Candidate time | Baseline checks | Candidate checks | Candidate teammates |
| --- | ---: | ---: | ---: | ---: | ---: |
| event-delivery | 6m30s | 4m48s | 34/34 | 34/34 | 1 |
| workspace-indexer | 6m24s | 7m50s | 47/47 | 47/47 | 2 |

Times include waiting for active descendants after the root answer. Indexer timing was recovered after a shutdown-only harness failure: **468.650–470.325 seconds**; tables conservatively use the upper bound (7m50s). Its root-only/settle breakdown is approximate. The first Ctrl+D left an idle Pi UI; a second exited it. No model prompt, repair, or grading-feedback retry occurred. Shutdown recovery time is excluded. Candidate grading took event-delivery: 0.52s, workspace-indexer: 0.49s.

## Usage

| Arm / problem | Input | Output | Cache read | Total including cache |
| --- | ---: | ---: | ---: | ---: |
| Baseline / event-delivery | 39,880 | 13,195 | 852,608 | 905,683 |
| Baseline / workspace-indexer | 41,254 | 11,006 | 1,110,784 | 1,163,044 |
| **Baseline total** | 81,134 | 24,201 | 1,963,392 | 2,068,727 |
| Prior candidate / event-delivery | 71,426 | 15,302 | 1,224,064 | 1,310,792 |
| Prior candidate / workspace-indexer | 149,607 | 18,146 | 2,352,256 | 2,520,009 |
| **Prior candidate total** | 221,033 | 33,448 | 3,576,320 | 3,830,801 |
| Candidate / event-delivery | 74,310 | 16,371 | 1,454,592 | 1,545,273 |
| Candidate / workspace-indexer | 140,013 | 20,184 | 2,288,128 | 2,448,325 |
| **Candidate total** | 214,323 | 36,555 | 3,742,720 | 3,993,598 |

Usage includes all root/child transcripts; reasoning is already in output. Supervisor work is excluded. Subscription allowance weighting and dollar cost are unknown. Cache-inclusive totals are not equivalent to fresh input/output consumption.

## Coordination and checks

- event-delivery: 2 session(s); `team_agent` 2, `team_message` 3, `team_task` 8 calls; 0 assistant errors, 0 aborted requests.
  - Child `dispatch`: session present=True; both required AC Stack IDs selected=True.
- workspace-indexer: 3 session(s); `team_agent` 3, `team_message` 10, `team_task` 14 calls; 0 assistant errors, 0 aborted requests.
  - Child `persistence`: session present=True; both required AC Stack IDs selected=True.
  - Child `review`: session present=True; both required AC Stack IDs selected=True.

## Per-problem changes versus baseline

| Problem | Time | Input | Output | Cached reads | Total tokens | API-equivalent estimate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| event-delivery | -26.1% | +86.3% | +24.1% | +70.6% | +70.6% | $0.46 |
| workspace-indexer | +22.6% | +239.4% | +83.4% | +106.0% | +110.5% | $0.71 |

## Changes versus prior parallel-preference candidate

| Problem | Prior time | Current time | Time change | Input change | Output change | Cache read change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| event-delivery | 4m54s | 4m48s | -2.1% | +4.0% | +7.0% | +18.8% |
| workspace-indexer | 6m49s | 7m50s | +15.1% | -6.4% | +11.2% | -2.7% |

API estimates use Pi configured rates of $2/M uncached input, $10/M output, and $0.10/M cached reads. They are not actual subscription charges. All root/child usage is included; supervisor work excluded.

## Recorded coordination actions

- event-delivery: `{"team_agent:launch": 1, "team_agent:list": 1, "team_message:send": 3, "team_task:complete": 3, "team_task:create": 1, "team_task:read": 1, "team_task:start": 3}`. Custom record types: `{"ac-teams": 4, "ac-teams-team": 1, "acstack-writing-style-reminder": 2}`. Recorded tool errors: `{"bash": 3}`.
- workspace-indexer: `{"team_agent:launch": 2, "team_agent:list": 1, "team_message:send": 6, "team_message:wait": 3, "team_message:watch": 1, "team_task:complete": 4, "team_task:create": 1, "team_task:list": 1, "team_task:read": 2, "team_task:reopen": 1, "team_task:start": 5}`. Custom record types: `{"ac-teams": 9, "ac-teams-team": 1, "acstack-writing-style-reminder": 3}`. Recorded tool errors: `{"bash": 1, "team_task": 1}`.

The indexer reviewer used one persistent completion watch and two waits; the root used one wait for review. An early review-task start was correctly rejected with `Task is blocked by unfinished dependencies: 9946b43b-68c0-490e-a9d7-7e7519d31589`. After persistence completed, the watch cleared and review proceeded. Independent review passed; the root's final answer reported that result. The review member's eventual `interrupted` status came during shutdown, after its normal final answer, not an assistant abort. All three children actually read AC Stack skills: both implementers read implementation/test guidance, and the reviewer read test conventions.

This exercises watch/wait behavior, but does not isolate a causal speed or token benefit. Recorded tool errors include the blocked start and failing development commands; they are distinct from assistant/API errors. Useful independent review is not automatically avoidable overhead.

[Previous parallel-preference candidate](EXPANDED-PARALLEL-PREFERENCE.md). Prior results preserved.


## Reproducibility and limits

- Candidate entry: parent `message-audit/src/index.ts`, **not** an earlier snapshot. Source freeze `afbdc8627bc33fb13b5219637e5db73a7828190e50e028b563420a7ca5fa6e01`; all 31 source/package files matched before and after both runs.
- AC Stack package and both explicit extension entry fingerprints matched the baseline and stayed unchanged.
- All 38 problem/contract/reference/grader files and normalized task prompts matched the baseline. Model, effort, explicit extension set, project-worker configuration, and local launch/grading approach matched.
- Normal AC Teams settings applied; no eval-specific team-size/depth override, delegation hint, or attempt cutoff. No grader feedback, repair retry, or post-grading code changes.
- Native projects are instruction-confined, not OS-sandboxed or resource-isolated. Shared-host contention and model variance remain. One attempt per problem does not establish causal improvement or regression.

[Accepted baseline](EXPANDED-BASELINE.md) · [Safe detailed candidate results](results/expanded-v2-persistent-notifications-acstack-2026-11-05.json). Raw local attempts: `/tmp/ac-teams-small-local-20261105/runs/expanded-stack-w27-*/`.
