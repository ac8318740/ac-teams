import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policy } from "../src/config.ts";

test("policy precedence requires project opt-in and explicit authorization above ten", () => {
  const directory = mkdtempSync(join(tmpdir(), "at-policy-"));
  const previous = process.env.HOME;
  process.env.HOME = directory;
  mkdirSync(join(directory, ".acstack", "ac-teams"), { recursive: true });
  mkdirSync(join(directory, ".pi"));
  const user = join(directory, ".acstack", "ac-teams", "config.json");
  const project = join(directory, ".pi", "ac-teams.json");
  try {
    assert.deepEqual(policy(directory, false, {}), { limit: 10, depth: 2 });
    writeFileSync(user, JSON.stringify({ limit: 4 }));
    writeFileSync(project, JSON.stringify({ limit: 6, depth: 3 }));
    assert.deepEqual(policy(directory, false, {}), { limit: 4, depth: 2 });
    assert.deepEqual(policy(directory, true, {}), { limit: 6, depth: 3 });
    assert.deepEqual(policy(directory, true, { limit: "8", depth: "1" }), { limit: 8, depth: 1 });
    writeFileSync(project, JSON.stringify({ limit: 11 }));
    assert.throws(() => policy(directory, true, {}), /explicit --teams-limit/);
    assert.deepEqual(policy(directory, true, { limit: "11" }), { limit: 11, depth: 2 });
    for (const limit of ["0", "101", "1.5", "bad"]) assert.throws(() => policy(directory, false, { limit }), /1\.\.100/);
    assert.throws(() => policy(directory, false, { depth: "11" }), /0\.\.10/);
    writeFileSync(project, JSON.stringify({ unknown: true }));
    assert.throws(() => policy(directory, true, {}), /Invalid team policy/);
    writeFileSync(project, "{");
    assert.throws(() => policy(directory, true, {}), /Cannot read team policy/);
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
