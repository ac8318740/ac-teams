import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
function script(step: string): string {
  const start = workflow.indexOf(`      - name: ${step}\n`);
  assert.notEqual(start, -1);
  const block = workflow.slice(start).match(/        run: \|\n((?: {10}.*\n)+)/);
  assert.ok(block, `Missing shell script for ${step}`);
  return block[1].replace(/^ {10}/gm, "");
}

test("release tags must match the package version; manual dispatch remains available", () => {
  for (const [type, name, status] of [["tag", `v${version}`, 0], ["tag", "v9.9.9", 1], ["branch", "main", 0]] as const) {
    const result = spawnSync("bash", ["-c", script("Check release tag")], {
      env: { ...process.env, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: name }, encoding: "utf8",
    });
    assert.equal(result.status, status, result.stderr + result.stdout);
  }
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
