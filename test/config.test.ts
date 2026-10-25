import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policy, readDisplaySettings, saveDisplaySettings } from "../src/config.ts";

test("display defaults are independent, global, private, and preserve invalid files", () => {
  const home = mkdtempSync(join(tmpdir(), "at-display-")), previous = process.env.HOME;
  process.env.HOME = home;
  const file = join(home, ".acstack", "ac-teams", "display.json");
  try {
    assert.deepEqual(readDisplaySettings(), { tasks: true, agents: true });
    saveDisplaySettings({ tasks: false, agents: true });
    assert.deepEqual(readDisplaySettings(), { tasks: false, agents: true });
    saveDisplaySettings({ tasks: true, agents: false });
    assert.deepEqual(readDisplaySettings(), { tasks: true, agents: false });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, '{"tasks":false}');
    assert.deepEqual(readDisplaySettings(), { tasks: false, agents: true });
    for (const invalid of ['{"tasks":"no"}', '{"agents":1}', '{"unknown":true}', '[]', 'null', '{']) {
      writeFileSync(file, invalid);
      assert.throws(readDisplaySettings, /display settings/);
      assert.throws(() => saveDisplaySettings({ tasks: true, agents: true }), /display settings/);
      assert.equal(readFileSync(file, "utf8"), invalid);
    }
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

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
