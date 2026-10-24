import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
function script(step: string): string {
  const start = workflow.indexOf(`      - name: ${step}\n`);
  assert.notEqual(start, -1);
  const block = workflow.slice(start).match(/        run: \|\n((?: {10}.*\n)+)/);
  assert.ok(block, `Missing shell script for ${step}`);
  return block[1].replace(/^ {10}/gm, "");
}

test("only main can stage releases; dev, feature branches, tags, and missing refs fail closed", () => {
  for (const ref of ["refs/heads/main", "refs/heads/dev", "refs/heads/docs/shorten-readme", "refs/tags/v0.0.1", ""]) {
    const result = spawnSync("bash", ["-c", script("Check release branch")], {
      env: { ...process.env, GITHUB_REF: ref }, encoding: "utf8",
    });
    assert.equal(result.status, ref === "refs/heads/main" ? 0 : 1, result.stderr + result.stdout);
  }
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /^  (push|pull_request):/m);
  assert.ok(workflow.indexOf("- name: Check release branch") < workflow.indexOf("uses: actions/checkout"));
});

test("publishing requires a token, skips published versions, and never hides stage failures", () => {
  const mock = `npm() {
    if [[ "$1" == "view" ]]; then return "\${MOCK_VIEW_STATUS:-1}"; fi
    printf 'npm %s\\n' "$*"
    return "\${MOCK_STAGE_STATUS:-0}"
  }\n`;
  const run = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", mock + script("Stage release for npm approval")], {
    env: { ...process.env, NODE_AUTH_TOKEN: "test-not-a-real-token", MOCK_VIEW_STATUS: "1", MOCK_STAGE_STATUS: "0", ...env }, encoding: "utf8",
  });
  const missing = run({ NODE_AUTH_TOKEN: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Set NPM_TOKEN/);
  const published = run({ MOCK_VIEW_STATUS: "0" });
  assert.equal(published.status, 0);
  assert.doesNotMatch(published.stdout, /npm stage/);
  const staged = run({});
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.stdout, /npm stage publish \. --access public --provenance/);
  assert.match(staged.stdout, /2FA/);
  assert.equal(run({ MOCK_STAGE_STATUS: "23" }).status, 23);
});
