import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("test runner isolates Pi settings, forwards arguments and failures, and cleans up", () => {
  const root = mkdtempSync(join(tmpdir(), "ac-teams-test-runner-"));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const record = join(root, "record");
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/node"), `#!/bin/sh
[ -d "$HOME" ] && [ -z "$(ls -A "$HOME")" ] || exit 99
printf '%s\\n' "$HOME" "\${PI_CODING_AGENT_DIR-unset}" "$@" > "$RECORD"
exit "$STATUS"
`, { mode: 0o700 });
    for (const [args, status] of [[[], 0], [["--test-name-pattern=two words", "test/store.test.ts"], 23]] as const) {
      const result = spawnSync("sh", ["scripts/test.sh", ...args], {
        cwd, encoding: "utf8",
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: "/personal/pi", RECORD: record, STATUS: String(status) },
      });
      assert.equal(result.status, status, result.stderr);
      const [home, agentDir, ...forwarded] = readFileSync(record, "utf8").trimEnd().split("\n");
      assert.notEqual(home, root);
      assert.equal(agentDir, "unset");
      assert.deepEqual(forwarded, ["--experimental-strip-types", "--test", ...(args.length ? args : readdirSync(join(cwd, "test")).filter(name => name.endsWith(".test.ts")).sort().map(name => `test/${name}`))]);
      assert.equal(existsSync(home), false);
      assert.ok(existsSync(root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
