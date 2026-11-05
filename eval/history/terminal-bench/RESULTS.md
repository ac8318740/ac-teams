# Exploratory comparison results

Both versions passed both tasks with an independent reviewer in every trial. This sample does not demonstrate an efficiency improvement: the candidate took longer and used more uncached input/output tokens, despite fewer coordination calls and fewer total tokens including cached reads.

## Results

One trial per variant and task. Times exclude grading. Token counts aggregate root and reviewer usage.

| Task | Variant | Original reward | Agent seconds | Uncached input + output tokens | Total tokens, including cached reads |
| --- | --- | ---: | ---: | ---: | ---: |
| regex-log | 0.0.27 | 1 | 180.62 | 44,997 | 223,173 |
| regex-log | Candidate | 1 | 173.63 | 40,244 | 200,372 |
| log-summary-date-ranges | 0.0.27 | 1 | 91.42 | 24,670 | 188,894 |
| log-summary-date-ranges | Candidate | 1 | 142.60 | 43,131 | 186,619 |

| Aggregate | 0.0.27 | Candidate |
| --- | ---: | ---: |
| Tasks passed | 2/2 | 2/2 |
| Agent seconds | 272.04 | 316.22 |
| Original grading seconds | 19.41 | 17.89 |
| Uncached input + output tokens | 69,667 | 83,375 |
| Cached-read tokens | 342,400 | 303,616 |
| Total tokens | 412,067 | 386,991 |
| Coordination tool calls | 31 | 26 |
| Board posts | 8 | 7 |
| Delivered notice bytes | 1,946 | 2,181 |
| History/search response text bytes | 0 | 1,853 |
| Explicit detail fetches | 0 | 1 |

The candidate used 16.2% more agent time and 19.7% more uncached input/output tokens. Total tokens fell 6.1%, mostly through fewer cached reads. Token categories are not dollar costs or a measured subscription-allowance charge. Coordination calls comprise `team_agent`, `team_task`, and `team_message`; byte counts are payload proxies, not token counts.

The candidate regex reviewer independently checked 24,815 cases and identified a trailing-newline integration caveat, which the implementer fixed. The root explicitly fetched review detail. Useful independent review survived the summary-first behavior. However, baseline trials made no history/search calls, so this sample does not test savings from replacing broad baseline history retrieval. Fewer calls alone did not produce a faster suite.

## Execution

- Baseline: AC Teams 0.0.27, `463b2001a8dc26af14faded8414465a7d8288126`.
- Candidate: that revision plus frozen message-audit changes. Full source/package SHA-256: `5e5cf537caaa76be3e161759719415c338451fcdb50d22d754a060a953422b97`. See `candidate-source-manifest.json`.
- Public Terminal-Bench 2.0 revision: `2fd12b88aafdd04a52c298e3940bcb189f9766d6`. This is a custom subset, not an official score or Harbor-equivalent run.
- Pi 1.5.0, Node 22.23.4, Docker 29.9.2; `openai/gpt-6.1-sol`, medium thinking, existing subscription OAuth. API-key environment variables suppressed; no global installs or settings changes.
- Four fresh native-tool Pi roots, each with one reviewer, maximum two live sessions, depth one, and a 240-second attempt budget. Order: candidate regex, baseline regex, baseline dates, candidate dates.
- Models used normal filesystem/shell tools in fresh host directories. No model containers or custom execution adapter. Task prompts mapped `/app` to the trial directory. The directory restriction was an instruction, not a sandbox or resource cap.
- Original task inputs came from upstream images. After Pi exited, a snapshot was graded with unchanged original tests in a fresh 1-CPU, 2-GiB container. Solutions and tests were not placed in model task directories or prompts, but host access was not technically blocked.
- A benchmark-local parent/all worker preset was enabled explicitly with `--teams-project-config`. Reviewer handshakes and transcripts were verified. All four trials have two actual sessions and completed independent review reports.
- No assistant errors. Each dates trial has one child abort 10 ms after the parent's explicit stop, after review completion; these are shutdowns, not failed launches.
- Candidate source hashes and all 31 baseline source/package files matched their frozen inputs after execution. Upstream checkout remained clean.

The valid warm suite took **10m 48s**, from 2026-11-05 15:37:00 UTC to 15:47:48 UTC, including inter-trial startup and grading. This excludes substantial earlier setup/debugging; the original overall elapsed-time target was not met.

## Excluded attempts and limits

Earlier pilots used a custom container execution adapter. A global worker preset changed between runs and requested disabled `builtin:codemode`; the attempted local override was ineffective because `--teams-project-config` was missing. The adapter also rejected incomplete launch arguments. These were setup failures, not candidate regressions. All previous container-model trials, including successful baseline runs, are excluded to keep the final comparison on one execution method.

Excluded attempts consumed **738,604 reported tokens**, including 601,600 cached reads and 137,004 uncached input/output tokens. Valid trials consumed 799,058 total tokens. Combined observed usage was **1,537,662 tokens**. Existing subscription allowance was consumed; its remaining balance and dollar cost were not measured. These totals do not include this supervising conversation or the parent team's work.

Two data-processing tasks, one attempt per cell, and a ceiling result cannot establish quality parity generally, a causal speedup, or a reliable allowance reduction. Host access and shared-host load are additional limitations. Use these results as a functioning smoke comparison, not evidence for a performance claim.

Machine-readable results, session IDs, exclusions, and usage are in `results.json`. Local launch scripts and raw artifacts remain under `/tmp/ac-teams-small-local-20261105`; they are not a shipped session harness. Both original oracle/blank controls passed for each task (1/0), and all four control-runner unit tests passed.
