import test from "node:test";
import assert from "node:assert/strict";
import { teamsCompletions, resolveTeammate } from "../src/commands.ts";

const members = [{ id: "root", status: "idle" as const }, { id: "1234-abcd-5678", name: "code-review", status: "busy" as const }];
test("teams actions and teammate names complete without memorizing IDs", () => {
  assert.deepEqual(teamsCompletions("", members)?.map(item => item.value), ["panel", "teammate", "config", "back", "stop", "status"]);
  assert.deepEqual(teamsCompletions("co", members)?.map(item => item.value), ["config"]);
  assert.deepEqual(teamsCompletions("teammate c", members)?.map(item => item.value), ["teammate code-review"]);
  assert.deepEqual(teamsCompletions("teammate 1234", members)?.map(item => item.value), ["teammate code-review"]);
  assert.deepEqual(teamsCompletions("teammate ", members)?.map(item => item.label), ["main", "code-review"]);
  assert.deepEqual(teamsCompletions("open co", members)?.map(item => item.value), ["open code-review"]);
  assert.equal(teamsCompletions("config extra", members), null);
  assert.deepEqual(teamsCompletions("teammate missing", members), []);
});
test("teammate destinations accept exact names, IDs, and Main, never an ambiguous prefix", () => {
  assert.equal(resolveTeammate(members, "code-review"), members[1].id);
  assert.equal(resolveTeammate(members, members[1].id), members[1].id);
  assert.equal(resolveTeammate(members, "main"), "root");
  assert.equal(resolveTeammate(members, "root"), "root");
  assert.equal(resolveTeammate(members, "code"), undefined);
  assert.equal(resolveTeammate(members, "missing"), undefined);
});
