# Custom-problem baseline with AC Stack

Both problems passed on AC Teams 0.0.27 with AC Stack 0.56.0 loaded. Both agents worked solo. Adding AC Stack did not produce delegation in these two attempts.

| Problem | Model attempt | Grading | Visible tests | Additional tests | Sessions | Teammates launched |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Event delivery | 3m13s | 0.56s | 3/3 | 12/12 | 1 | 0 |
| Workspace indexer | 3m35s | 0.74s | 3/3 | 13/13 | 1 | 0 |

Each problem had a fresh root agent and project, and both ran concurrently on the shared host. Times are per problem, not suite wall time. No attempt cutoff or evaluation-specific team-size/depth override was imposed. The effective normal Teams configuration was limit 10, depth 2. Task prompts did not suggest delegation.

## Plugin and source verification

- AC Teams baseline: `463b2001a8dc26af14faded8414465a7d8288126` (0.0.27). All 31 source/package files matched the pinned revision before and after the runs.
- AC Stack: installed 0.56.0, explicitly loaded alongside the baseline Teams extension. Both package extension fingerprints remained unchanged.
- Both accepted root transcripts contain AC Stack's writing-style hook output and reads of its `implement` and `test-conventions` skills. AC Stack's extension supplies its own skill discovery and orchestrator context even with Pi's generic discovery disabled.
- Both AC Stack extension IDs were required in the local worker policy. No child was launched, so actual child plugin loading was not exercised.
- Runtime: Pi 1.5.0, Node 22.23.4, `openai/gpt-6.1-sol`, medium thinking, subscription OAuth.

AC Stack's installed adaptive policy permits direct work on straightforward tasks. Loading it is not a guarantee of delegation. These results show that plugin presence alone was insufficient here, not that it can never affect coordination.

## Quality and coordination

Original visible tests and withheld graders ran against source snapshots after the model processes exited. No grader feedback was given to the agents, and no repair retry was run. Task contracts, starter files, and graders were unchanged.

Neither accepted root called `team_agent` or `team_message`. Each made three `team_task` calls for one self-owned task and produced one automatic task-completion post. Those are self-planning actions, not inter-agent coordination. There were no assistant errors or aborted requests.

Both problems remain quality-ceiling cases in this pilot. Natural delegation and the intended coordination stress have not been demonstrated. One attempt per problem cannot establish general performance or causal plugin effects. Native projects were not OS-sandboxed or resource-isolated.

## Usage

| Accepted run | Input | Output | Cache read | Total including cache |
| --- | ---: | ---: | ---: | ---: |
| Event delivery | 60,234 | 5,669 | 375,040 | 440,943 |
| Workspace indexer | 28,819 | 6,739 | 534,016 | 569,574 |
| Total | 89,053 | 12,408 | 909,056 | 1,010,517 |

Reasoning counts are already included in output and are not added again. Usage consumes subscription allowance; allowance weighting, remaining allowance, and dollar cost are unknown. Supervisor work is excluded.

## Superseded Teams-only diagnostics

The first two attempts omitted AC Stack. Both passed solo: delivery 170.77s, indexer 168.72s. They are not the accepted baseline configuration. Their 367,045 total tokens remain recorded separately rather than hidden as setup overhead. All four observed attempts used 1,377,562 tokens including cache reads, excluding supervisor work.

Task prompts were identical after normalizing workspace paths. The repeat used fresh projects and sessions; the only intended workflow change was requiring AC Stack alongside Teams. The sample is too small for causal timing or delegation claims.

Detailed safe metrics, source hashes, plugin fingerprints, and diagnostic results: [baseline-acstack-2026-11-05.json](baseline-acstack-2026-11-05.json). Raw transcripts remain in local `/tmp/ac-teams-small-local-20261105/runs/custom-stack-b27-event-delivery/` and `/tmp/ac-teams-small-local-20261105/runs/custom-stack-b27-workspace-indexer/`.

No candidate trial was run. The earlier candidate snapshot is historical; any future comparison needs a fresh candidate freeze and the same AC Stack plugin set.
