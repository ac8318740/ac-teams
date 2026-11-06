# Batching independent reads: no overall win established

The batching candidate passes all 82 strengthened grader checks, versus 81 for the new baseline. It does not establish a quality-preserving speed improvement: the concurrent pair finishes 3.8% later, and fresh input plus output rises 29.1%.

The baseline indexer stops with independent durability review blocked by launch errors. Its time is therefore not a completed-work comparison. A supplemental event probe also finds a robustness difference favoring the baseline.

## The user adopts batching as the next baseline

The user authorizes merging the batching guidance to `dev` on November 6, 2026, despite these limits. The next agent starts from that baseline and runs another audit, hypothesis, implementation, evaluation, and assessment. This decision does not establish a causal speed or quality improvement. No npm publication accompanies this merge.

## The grader ships separately

[PR #74](https://github.com/ac8318740/ac-teams/pull/74) merges only the indexer regression, reference fix, and relevant documentation to `dev` at `764e42af33fdfff60de2b5d16b6c5f3d459071ff`. The feature branch integrates the latest `origin/dev` after its initial push; it is already current. Both references pass all 82 checks; evaluation tooling passes 17 tests, and both typechecks pass. No npm version changes.

This change ships the guidance and its evidence, without a version bump. Earlier guidance experiments remain preserved in the named stash and their original temporary snapshots.

## One change targets serial tool turns

The candidate adds one sentence to the existing AC Teams guideline in `src/index.ts`:

> Batch independent file reads and read-only checks in the same tool turn, including during review; serialize only when a result determines the next call.

The hypothesis is fewer model turns between independent reads, not necessarily parallel input/output. A prior baseline reviewer reads six files across six turns. Other agents already batch reads, so the expected gain is uncertain.

No runtime logic, schemas, task defaults, required checks, or review requirements change. The previous helper-ownership and completion-watch candidate is not included.

ACStack 0.56.0 and AC Teams load in every root and child. ACStack remains fixed for this isolated experiment. Inspection of its shared implementation policy and task-checker instructions finds no clear performance edit: they already permit focused review, evidence reuse, and flexible delegation. Authorization to change ACStack does not justify another unmeasured instruction.

## Four new attempts use the strengthened grader

Both conditions use nominal AC Teams 0.0.29, Pi 1.5.0, `openai/gpt-6.1-sol`, medium thinking, and the same two required ACStack extensions. The baseline is the merged `dev` snapshot. The candidate differs only in the sentence above.

| Frozen condition | Runtime source freeze |
| --- | --- |
| Baseline | `77b9441647530bb2fd647743bda903a4bd0c5cc2e19859a976d05a6953d0b407` |
| Batching candidate | `e7d51ad93cc9cda9f1bc69ec79d95fddf50f08740d3d205c04e9cead0a01fd03` |

Each pair runs concurrently; the baseline pair finishes and exits before the candidate pair starts. The native host is shared and not resource-isolated. Normal team limits apply, with no model cutoff or repair prompts. The experiment spans November 5–6, 2026 (UTC).

| Problem | Baseline seconds | Candidate seconds | Change | Baseline grade | Candidate grade |
| --- | ---: | ---: | ---: | ---: | ---: |
| Event delivery | 336.308 | 273.263 | -18.7% | 34/34 | 34/34 |
| Workspace indexer | 326.867 | 348.989 | +6.8% | 47/48 | 48/48 |

The concurrent pair span rises from 336.308 to 348.989 seconds (+3.8%). Summed attempt time falls from 663.175 to 622.252 seconds (-6.2%); this sum is not parallel wall time. Timing ends after final root/descendant model work, before shutdown and grading.

| Whole-team usage | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Fresh input | 173,297 | 231,915 | |
| Output | 33,866 | 35,587 | |
| Fresh input plus output | 207,163 | 267,502 | +29.1% |
| Cache reads | 3,265,536 | 3,302,912 | |
| All tokens | 3,472,699 | 3,570,414 | +2.8% |
| Model sessions | 4 | 5 | |

Reasoning is already included in output. Cache writes are zero. Supervisor usage is excluded. Subscription charges and allowance weighting are unknown.

## Batching increases, but review scope differs

A batched read turn contains at least two `read` calls in one assistant message. These counts do not prove equivalent review coverage or simultaneous execution.

| Attempt | Read calls | Turns containing reads | Turns containing multiple reads | Assistant messages |
| --- | ---: | ---: | ---: | ---: |
| Baseline event | 22 | 16 | 1 | 60 |
| Candidate event | 23 | 7 | 6 | 43 |
| Baseline indexer | 21 | 7 | 5 | 44 |
| Candidate indexer | 42 | 14 | 10 | 58 |

The event candidate reads a similar number of files with fewer read turns. The indexer candidate performs more review: it uses a third session, whereas the baseline stops before independent review completes. This prevents attributing the overall time or token difference to batching.

### The new baseline exposes the recovery defect again

The baseline indexer passes its 34 local tests but fails the newly shipped held-out case with `TypeError: Noncontiguous journal revisions`.

`/tmp/ac-teams-batch-20261105/runs/bb29-workspace-indexer/submission/src/storage.ts:82` appends to all retained entries. After opening checkpoint revision 5 with covered journal revision 1, the next commit creates `[1, 6]`. Reopening rejects that gap.

The baseline also requests an enforced read-only durability reviewer. Its first launch refuses access to private Pi directories. Its second fails with `No package root for /tmp/ac-teams-batch-20261105/pi-child`. The root asks permission for a prompt-only reviewer and stops. No permission bypass or follow-up prompt occurs.

The controller's `valid_trial: true` records unchanged source and a normal terminal model stop. It does not certify completed task requirements or independent review. The saved failed grade remains a legitimate observation, not a completed-work speed baseline.

### The candidate includes useful independent review

The candidate event implementation passes 32 local tests and strict source typechecking. The dispatch author reviews different code, `broker.ts` and `state.ts`; the root reviews dispatch integration. No reviewer claims exhaustive behavioral coverage.

The candidate indexer passes 39 local tests and strict source typechecking. Its storage author independently identifies the covered-history gap and adds a persisted commit/reopen regression before grading. `src/storage.ts:99-101` discards obsolete history before appending. A separate prompt-only reviewer reads all source and tests, reruns checks, and probes callback visibility, migration, cleanup failure, reopen, commit, and malformed stored values. It finds no blocking issue. This review is not operating-system enforced.

The assessment inspects the decisive persistence implementation and event dispatch code. It does not establish an independent maintainability score or prove the absence of other defects.

### A supplemental event probe limits the quality claim

The baseline event reviewer finds that an unprintable thrown value can abort dispatch and leave unrestorable state. The root adds safe error conversion, a regression, and an independent recheck before completing.

The candidate still uses `error instanceof Error ? error.message : String(error)` at `/tmp/ac-teams-batch-20261105/runs/bc29-event-delivery/submission/src/dispatch.ts:147`.

A post-run public-entry probe throws `Object.create(null)` for the first of two due events. The baseline continues to the second event and remains restorable. The candidate throws `TypeError: Cannot convert object to primitive value`, skips the peer, and cannot restore its dispatch list.

The contract requires continuing after thrown values but specifies `String(error)` without defining a fallback when conversion itself throws. Record this as a robustness gap, not an unannounced new official grade. Neither scored submission is repaired.

## Evidence and limits

The [machine-readable record](results/expanded-v2-batching-acstack-2026-11-06.json) includes source hashes, the exact patch, runtime environments, usage, grades, session hashes, fixture/submission hashes, batching counts, and the supplemental probe.

Raw evidence and both frozen source trees remain under `/tmp/ac-teams-batch-20261105`. The `bb29-*` attempts are baseline; `bc29-*` are candidate.

Verified:

- Source and ACStack manifests match before and after each attempt.
- Both conditions use identical fixtures and task prompts, except project paths.
- All nine model transcripts contain the correct condition's guidance.
- Every descendant selects both required ACStack extensions.
- No model errors, aborts, task-prompt resends, or grader-feedback repairs occur.
- Submission hashes remain unchanged after grading and supplemental probes.
- All owned model processes exit; visible test tabs remain.
- AC Teams typecheck passes; its isolated-home suite passes 261/261 tests.
- The local controller and Unicode-usage checks pass 11/11 tests.
- The language server cannot confirm a clean recheck; compiler evidence supplies the typecheck.

Two controller setup failures occur before any model prompt because the new `runs` directory is missing. Creating it resolves setup. The baseline indexer recorder exits nonzero after saving reward 0, as expected for a failed grade; this is not a model retry.

One trial per problem per condition cannot establish causality. The blocked baseline review, different candidate review scope, shared host load, and supplemental robustness gap prevent a clean optimization claim. The initial assessment advises against promotion on these trials alone. The user's later decision adopts the guidance as the next baseline, without changing that assessment.
