import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { TaskView, TeamState } from "../src/types.ts";

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "ac-task-state-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const initial: TeamState = { version: 3, id: "team", root: "root", limit: 3, depth: 1, tasks: {}, messages: [], members: {
    root: { id: "root", depth: 0, token: "r", cwd: home, status: "idle", notified: 0 },
    a: { id: "a", parent: "root", depth: 1, token: "a", cwd: home, status: "idle", notified: 0 },
    b: { id: "b", parent: "root", depth: 1, token: "b", cwd: home, status: "idle", notified: 0 },
  } };
  const store = new Store(initial, home);
  t.after(() => store.close());
  const create = (dependencies: string[] = []) => store.task("root", { action: "create", title: "Task", description: "Check behavior", dependencies }) as TaskView;
  return { store, home, initial, create };
}

test("checkout reserves blocked to-do work without starting it; readiness is derived", t => {
  const { store, create } = fixture(t);
  const first = create();
  const second = create();
  const task = create([first.id, second.id]);
  const reserved = store.task("a", { action: "claim", id: task.id }) as TaskView;
  assert.equal(reserved.status, "todo");
  assert.equal(reserved.owner, "a");
  assert.deepEqual(reserved.blockedBy, [first.id, second.id]);
  assert.throws(() => store.task("b", { action: "claim", id: task.id }), /already owned/i);
  assert.throws(() => store.task("a", { action: "start", id: task.id }), /blocked.*dependencies/i);
  for (const prerequisite of [first, second]) {
    store.task("b", { action: "claim", id: prerequisite.id });
    store.task("b", { action: "start", id: prerequisite.id });
    assert.ok((store.task("a", { action: "read", id: task.id }) as TaskView).blockedBy.includes(prerequisite.id));
    store.task("b", { action: "complete", id: prerequisite.id, acceptance: true });
  }
  const ready = store.task("a", { action: "read", id: task.id }) as TaskView;
  assert.equal(ready.status, "todo");
  assert.deepEqual(ready.blockedBy, []);
  assert.equal(ready.revision, reserved.revision);
  const listed = store.task("a", { action: "list" });
  assert.ok("tasks" in listed);
  assert.deepEqual(listed.tasks.find(t => t.id === task.id)?.blockedBy, []);
  assert.equal(Object.hasOwn(store.state.tasks[task.id], "blockedBy"), false);
  assert.throws(() => store.task("b", { action: "start", id: task.id }), /owner/i);
  store.task("a", { action: "start", id: task.id });
  assert.equal(store.state.tasks[task.id].status, "in_progress");
});

test("completion time persists for summary ordering and is cleared on reopen", t => {
  const { store, home, initial, create } = fixture(t);
  const task = create();
  store.task("a", { action: "claim", id: task.id });
  store.task("a", { action: "start", id: task.id });
  t.mock.method(Date, "now", () => 400);
  store.task("a", { action: "complete", id: task.id, acceptance: true });
  assert.equal(store.state.tasks[task.id].completedAt, 400);
  assert.throws(() => store.update(state => { state.tasks[task.id].completedAt = NaN; }), /completion time/);
  store.close();
  const reopened = new Store(initial, home);
  try {
    assert.equal(reopened.state.tasks[task.id].completedAt, 400);
    reopened.task("a", { action: "reopen", id: task.id });
    assert.equal(reopened.state.tasks[task.id].completedAt, undefined);
  } finally { reopened.close(); }
});

test("release clears reservations, resets active work, and never reopens done work", t => {
  const { store, create } = fixture(t);
  const task = create();
  assert.throws(() => store.task("a", { action: "start", id: task.id }), /owner/i);
  store.task("a", { action: "claim", id: task.id });
  assert.throws(() => store.task("a", { action: "complete", id: task.id, acceptance: true }), /in.progress/i);
  assert.throws(() => store.task("b", { action: "release", id: task.id }), /owner/i);
  store.task("a", { action: "release", id: task.id });
  assert.equal(store.state.tasks[task.id].status, "todo");
  assert.equal(store.state.tasks[task.id].owner, undefined);
  store.task("b", { action: "claim", id: task.id });
  store.task("b", { action: "start", id: task.id });
  store.task("b", { action: "release", id: task.id });
  assert.equal(store.state.tasks[task.id].status, "todo");
  assert.equal(store.state.tasks[task.id].owner, undefined);
  store.task("a", { action: "claim", id: task.id });
  store.task("a", { action: "start", id: task.id });
  assert.throws(() => store.task("a", { action: "complete", id: task.id }), /acceptance/i);
  store.task("a", { action: "complete", id: task.id, acceptance: true });
  store.task("a", { action: "release", id: task.id });
  assert.equal(store.state.tasks[task.id].status, "done");
  assert.equal(store.state.tasks[task.id].owner, undefined);
  assert.throws(() => store.task("b", { action: "claim", id: task.id }), /done|reopen/i);
  store.task("b", { action: "reopen", id: task.id });
  assert.equal(store.state.tasks[task.id].status, "todo");
});

test("owners can edit reserved to-do tasks, but active dependencies stay frozen", t => {
  const { store, create } = fixture(t);
  const prerequisite = create();
  const task = create();
  store.task("a", { action: "claim", id: task.id });
  assert.throws(() => store.task("b", { action: "edit", id: task.id, title: "Steal" }), /owner/i);
  store.task("a", { action: "edit", id: task.id, dependencies: [prerequisite.id] });
  assert.throws(() => store.task("root", { action: "edit", id: prerequisite.id, dependencies: [task.id] }), /cyclic/i);
  store.task("a", { action: "edit", id: task.id, dependencies: [] });
  store.task("a", { action: "start", id: task.id });
  assert.throws(() => store.task("a", { action: "edit", id: task.id, dependencies: [prerequisite.id] }), /to.do/i);
});

test("reopening is explicit and cannot invalidate active or completed dependents", t => {
  const { store, create } = fixture(t);
  const prerequisite = create();
  store.task("a", { action: "claim", id: prerequisite.id });
  store.task("a", { action: "start", id: prerequisite.id });
  store.task("a", { action: "complete", id: prerequisite.id, acceptance: true });
  assert.throws(() => store.task("b", { action: "reopen", id: prerequisite.id }), /owner/i);
  const task = create([prerequisite.id]);
  store.task("b", { action: "claim", id: task.id });
  store.task("a", { action: "reopen", id: prerequisite.id });
  assert.throws(() => store.task("b", { action: "start", id: task.id }), /blocked/i);
  store.task("a", { action: "start", id: prerequisite.id });
  store.task("a", { action: "complete", id: prerequisite.id, acceptance: true });
  store.task("b", { action: "start", id: task.id });
  assert.throws(() => store.task("root", { action: "reopen", id: prerequisite.id }), /dependent/i);
  store.task("b", { action: "complete", id: task.id, acceptance: true });
  assert.throws(() => store.task("a", { action: "reopen", id: prerequisite.id }), /dependent/i);
});

test("new transitions honor revisions and survive restart with independent ownership", t => {
  const { store, create, home, initial } = fixture(t);
  const task = create();
  const claimed = store.task("a", { action: "claim", id: task.id }) as TaskView;
  assert.throws(() => store.task("a", { action: "start", id: task.id, revision: task.revision }), /revision/i);
  store.task("a", { action: "start", id: task.id, revision: claimed.revision });
  store.task("a", { action: "complete", id: task.id, acceptance: true });
  const done = store.task("a", { action: "release", id: task.id }) as TaskView;
  assert.throws(() => store.task("root", { action: "reopen", id: task.id, revision: done.revision - 1 }), /revision/i);
  const reserved = create([task.id]);
  store.task("b", { action: "claim", id: reserved.id });
  store.close();
  const reopened = new Store(initial, home);
  t.after(() => reopened.close());
  assert.equal(reopened.state.tasks[task.id].status, "done");
  assert.equal(reopened.state.tasks[task.id].owner, undefined);
  assert.equal(reopened.state.tasks[reserved.id].status, "todo");
  assert.equal(reopened.state.tasks[reserved.id].owner, "b");
  reopened.task("root", { action: "reopen", id: task.id, revision: done.revision });
  assert.deepEqual((reopened.task("b", { action: "read", id: reserved.id }) as TaskView).blockedBy, [task.id]);
});

test("legacy progress migrates durably without losing owners, dependencies, or revisions", t => {
  const { store, home, initial } = fixture(t);
  const path = join(store.dir, "state.json");
  store.close();
  const legacy = { ...initial, version: 1, tasks: {
    first: { id: "first", title: "First", description: "Complete", dependencies: [], status: "completed", owner: "a", revision: 4 },
    next: { id: "next", title: "Next", description: "Active", dependencies: ["first"], status: "claimed", owner: "b", revision: 2 },
    last: { id: "last", title: "Last", description: "Waiting", dependencies: ["next"], status: "pending", revision: 1 },
  } };
  writeFileSync(path, JSON.stringify(legacy));
  const reopened = new Store(initial, home);
  assert.equal(reopened.state.version, 3);
  assert.deepEqual(Object.values(reopened.state.tasks).map(t => [t.status, t.owner, t.revision]), [["done", "a", 4], ["in_progress", "b", 2], ["todo", undefined, 1]]);
  assert.deepEqual(reopened.state.tasks.next.dependencies, ["first"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), reopened.state);
  reopened.close();
  const again = new Store(initial, home);
  assert.equal(again.state.tasks.next.status, "in_progress");
  again.close();
  writeFileSync(path, JSON.stringify({ ...legacy, tasks: { broken: { ...legacy.tasks.last, id: "broken", status: "claimed" } } }));
  const before = readFileSync(path, "utf8");
  assert.throws(() => new Store(initial, home), /owner/i);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("malformed status types cannot be coerced into valid tasks or migrated to done", t => {
  const { store, home, initial } = fixture(t);
  const path = join(store.dir, "state.json");
  store.close();
  for (const [version, statuses] of [[1, ["pending", "claimed", "completed"]], [2, ["todo", "in_progress", "done"]]] as const) {
    for (const status of statuses) {
      const corrupt = { ...initial, version, tasks: {
        broken: { id: "broken", title: "Broken", description: "Reject", dependencies: [], owner: "root", revision: 1, status: [status] },
      } };
      writeFileSync(path, JSON.stringify(corrupt));
      const before = readFileSync(path, "utf8");
      assert.throws(() => new Store(initial, home), /task|status/i);
      assert.equal(readFileSync(path, "utf8"), before);
    }
  }
});
