# Experiment reports

These reports preserve observations from individual local experiments. They do not establish general performance advantages. Follow the linked report for exact source, extension, model, timing, and validity caveats; its linked JSON holds sanitized machine-readable evidence.

## Expanded systems (v2)

| Experiment | Report | Evidence |
| --- | --- | --- |
| Initial baseline | [Baseline](expanded-v2-baseline.md) | [JSON](../results/expanded-v2-baseline-acstack-2026-11-05.json) |
| First candidate | [Candidate comparison](expanded-v2-candidate.md) | [JSON](../results/expanded-v2-candidate-acstack-2026-11-05.json) |
| Parallel-preference guidance | [Comparison](expanded-v2-parallel-preference.md) | [JSON](../results/expanded-v2-parallel-preference-acstack-2026-11-05.json) |
| Persistent notifications | [Comparison](expanded-v2-persistent-notifications.md) | [JSON](../results/expanded-v2-persistent-notifications-acstack-2026-11-05.json) |
| Batching guidance | [Comparison and limits](expanded-v2-batching.md) | [JSON](../results/expanded-v2-batching-acstack-2026-11-06.json) |

The [initial validation manifest](expanded-v2-validation.json) identifies the earlier 81-check problem revision. A later indexer persistence regression added a covered-history recovery case, bringing the current validation to 82 checks. That change does not revise original attempt grades. Use `node eval/run.mjs check` for current validation, rather than treating an archived count as a current result.

## Retired benchmarks

- [Simple v1](../history/simple-v1/README.md): frozen smaller problems, validation manifest, baseline report, and result.
- [Terminal-Bench](../history/terminal-bench/README.md): historical reports and metrics; no active runner.

Do not compare these problem revisions as equivalent measurements. New experiments belong here, with a dated result in `../results/` and the provenance required by [the running guide](../running.md#report-a-comparison).
