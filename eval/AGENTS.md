# Evaluation maintenance

Read [README.md](README.md) for the directory layout and [running.md](running.md) before changing tooling or running a trial. These rules apply to everything under `eval/`.

## Keep navigation separate from evidence

- Keep `README.md` a stable overview. Put commands and the artifact contract in `running.md`, experiment narratives in `reports/`, and sanitized machine-readable evidence in `results/`.
- Link each new report and its result from `reports/README.md`. Use descriptive problem-revision/experiment filenames and dated result filenames. Do not add root-level experiment reports, duplicate baselines, or a rolling "latest win" narrative.
- Preserve historical observations and caveats. Fix links after moving reports; do not rewrite old measurements to match current behavior. Archive retired benchmarks together under `history/` with their contracts, manifests, and evidence.
- Keep raw attempts, transcripts, workspaces, source freezes, and machine-specific controllers outside the checkout. Never commit credentials, environment dumps, or private participant data.

## Preserve the measurement

- Changes to `problems/` alter the benchmark: contracts, fixtures, graders, and references must agree. Do not change them merely to tidy tooling or make a candidate pass.
- Preserve `history/simple-v1/` and its manifest. Tooling tests verify the frozen problem bytes.
- Never present different problem revisions, models, extension sets, or resource settings as equivalent arms. Record identities and caveats before execution; do not invent missing provenance afterward.
- Report per-problem correctness, time, whole-team usage, and actual delegation. Solo runs remain valid. Do not add delegation rewards, eval-specific team limits, arbitrary time cutoffs, or causal claims from single samples.
- The runner does not launch models or sandbox submissions. Follow the controller, shutdown, snapshot, and no-secrets requirements in `running.md`. Do not run paid model trials, delete artifacts, or change user extension settings without approval.

## Keep tooling small and verifiable

- Keep `run.mjs` and `record.mjs` beside `problems/`; their paths and bytes participate in recording/cache identity. Explain cache invalidation when changing them. Keep commands and JSON contracts compatible unless the task explicitly changes them.
- Use Node built-ins and existing helpers before adding dependencies or abstractions. Prefer readable control flow over dense one-line parsing, validation, or record construction.
- Keep tooling tests beside their modules as `*.test.mjs`. Add regression coverage for changed behavior; reuse existing tests for behavior-preserving refactors. Never weaken original-test enforcement, metadata validation, shutdown checks, or snapshot verification.
- Run `node --test eval/run.test.mjs eval/record.test.mjs` after tooling changes. Run `node eval/run.mjs check` after active problem or grading changes. Check relative links after documentation moves. Follow repository completion checks too, and report blocked checks precisely.

## Skills and extension selection

- Keep running instructions in the repository [eval-run skill](../.agents/skills/eval-run/SKILL.md) and audit instructions in [eval-audit](../.agents/skills/eval-audit/SKILL.md). Update relevant guidance when tooling contracts change.
- The run skill asks Teams-only first. Additional extensions come from the user's current enabled/loaded inventory, with recommendations based on the experiment and capability descriptions. Never hardcode an optional extension roster or this machine's paths.
- Use the host question tool when available. Paginate large selections within its limits, allow skipping, and treat dismissal as unresolved. Confirm the exact optional/required set before launch.
- Control and verify root loading separately from worker policy. Required safety/auth/coordination cannot be silently removed; disclose them. Missing controller or isolation evidence is a blocker, not permission to guess.
