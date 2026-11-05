# Expanded systems v2 baseline

AC Teams 0.0.27 + AC Stack 0.56.0: 2/2 problems passed. 0 teammates were created across both attempts.

| Problem | Model attempt | Grading | Foundation checks | New checks | Sessions | Teammates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| event-delivery | 6m30s | 0.57s | 15/15 | 19/19 | 1 | 0 |
| workspace-indexer | 6m24s | 0.57s | 16/16 | 31/31 | 1 | 0 |

Both problems had fresh projects and agents and ran concurrently. No eval-specific team-size/depth override, attempt cutoff, delegation hint, grader feedback, or repair retry was supplied. Reported attempt time includes any wait for active descendants after the root final answer; root-only time is recorded separately in JSON. Grading used original tests against source snapshots after root and active descendant completion.

## Usage

| Problem | Input | Output | Cache read | Total including cache |
| --- | ---: | ---: | ---: | ---: |
| event-delivery | 39,880 | 13,195 | 852,608 | 905,683 |
| workspace-indexer | 41,254 | 11,006 | 1,110,784 | 1,163,044 |
| Total | 81,134 | 24,201 | 1,963,392 | 2,068,727 |

Usage covers root and descendant transcripts. Reasoning tokens are already included in output, not added again. Subscription allowance weighting, remaining allowance, and dollar cost are unknown. Supervisor work is excluded.

## Coordination and quality

- event-delivery: `team_agent` 0, `team_message` 0, `team_task` 5 calls; 0 assistant errors, 0 aborted requests.
- workspace-indexer: `team_agent` 0, `team_message` 0, `team_task` 5 calls; 0 assistant errors, 0 aborted requests.

Both agents worked solo. Increased problem breadth did not produce natural delegation in these attempts. This round did not exercise inter-agent coordination.

## Verification and limits

- All 31 baseline source/package files matched pinned revision `463b2001a8dc26af14faded8414465a7d8288126` before and after the runs.
- Both AC Stack entry points and package metadata fingerprints remained unchanged during each attempt. Actual AC Stack skill activity was observed in both root transcripts.
- All 38 fixture/contract/reference/grader files remained unchanged. The [v2 validation manifest](expanded-v2-validation.json) identifies the problem revision.
- The runtime was Pi 1.5.0, v22.23.4, `openai/gpt-6.1-sol`, medium thinking, subscription OAuth.
- Native projects were not OS-sandboxed or resource-isolated. One attempt per problem cannot establish general performance, causal plugin effects, or baseline-versus-candidate differences.
- The [simple v1 baseline](history/simple-v1/BASELINE.md) used different, smaller problems and is not a direct score comparison.

[Detailed safe results](results/expanded-v2-baseline-acstack-2026-11-05.json). Raw transcripts, submitted source, and original TAP results remain under local `/tmp/ac-teams-small-local-20261105/runs/expanded-stack-b27-*/`.
