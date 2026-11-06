import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/team/store.ts";
import type { TaskView, TeamState } from "../src/types.ts";

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "ac-task-state-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const initial: TeamState = { version: 5, id: "team", key: "key", limit: 3, depth: 1, tasks: {}, messages: [], members: {
    root: { id: "root", role: "main", depth: 0, token: "r", cwd: home, status: "idle", notified: 0 },
    a: { id: "a", role: "member", parent: "root", depth: 1, token: "a", cwd: home, status: "idle", notified: 0 },
    b: { id: "b", role: "member", parent: "root", depth: 1, token: "b", cwd: home, status: "idle", notified: 0 },
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
    store.task("b", { action: "complete", id: prerequisite.id, acceptance: true, summary: "Done" });
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

test("batch create is atomic, supplies concise defaults, and preserves explicit details", t => {
  const { store, home, initial } = fixture(t);
  const result = store.task("root", { action: "create", tasks: [
    { title: "Research the existing implementation" },
    { title: "Implement change", label: "Implementation", description: "Acceptance: tests pass" },
  ] });
  assert.ok("tasks" in result);
  assert.equal(result.total, 2);
  assert.deepEqual(result.tasks.map(task => task.number), [1, 2]);
  assert.equal(result.tasks[0].label, "Research the existing");
  assert.equal(result.tasks[0].description, result.tasks[0].title);
  assert.equal(result.tasks[1].description, "Acceptance: tests pass");
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  for (const args of [
    { tasks: [] }, { title: "Ambiguous", tasks: [{ title: "No" }] },
    { tasks: [{ title: "Valid" }, { title: "Invalid", dependencies: ["missing"] }] },
    { tasks: [{ title: "Valid" }, { title: "   " }] },
    { tasks: [{ title: "Invalid", description: null as unknown as string }] },
    { tasks: [{ title: "Invalid", label: null as unknown as string }] },
    { tasks: Array.from({ length: 101 }, () => ({ title: "Too many" })) },
  ]) assert.throws(() => store.task("root", { action: "create", ...args }));
  assert.equal(Object.keys(store.state.tasks).length, 2);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
  const dependent = store.task("root", { action: "create", tasks: [{ title: "Follow up", dependencies: [result.tasks[0].id] }] });
  assert.ok("tasks" in dependent);
  assert.deepEqual(dependent.tasks[0].blockedBy, [result.tasks[0].id]);
  store.close();
  const reopened = new Store(initial, home);
  t.after(() => reopened.close());
  assert.equal(Object.keys(reopened.state.tasks).length, 3);
});

test("batch dependencies resolve forward keys and existing IDs, block starts, and persist only UUIDs", t => {
  const { store, home, initial, create } = fixture(t);
  const existing = create();
  const result = store.task("root", { action: "create", tasks: [
    { key: "bridge", title: "Host bridge", dependencies: ["@worker", existing.id] },
    { key: "broker", title: "Token broker" },
    { key: "worker", title: "Pi worker" },
    { title: "Integration", dependencies: ["@bridge", "@broker"] },
  ] });
  assert.ok("tasks" in result);
  const [bridge, broker, worker, integration] = result.tasks;
  assert.deepEqual(bridge.dependencies, [worker.id, existing.id]);
  assert.deepEqual(bridge.blockedBy, [worker.id, existing.id]);
  assert.deepEqual(broker.dependencies, []);
  assert.deepEqual(worker.dependencies, []);
  assert.deepEqual(integration.blockedBy, [bridge.id, broker.id]);
  assert.throws(() => store.task("a", { action: "start", id: bridge.id }), /blocked/i);
  for (const task of [worker, existing]) {
    store.task("a", { action: "start", id: task.id });
    store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Checked" });
  }
  store.task("b", { action: "start", id: bridge.id });
  assert.equal(store.state.tasks[bridge.id].status, "in_progress");
  assert.ok(result.tasks.every(task => !Object.hasOwn(task, "key")));
  const snapshot = readFileSync(join(store.dir, "state.json"), "utf8");
  assert.ok(!snapshot.includes('"key":"worker"'));
  assert.ok(!snapshot.includes("@worker"));
  store.close();
  const reopened = new Store(initial, home);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state.tasks[bridge.id].dependencies, [worker.id, existing.id]);
});

test("invalid batch keys and dependency graphs leave memory and disk unchanged", t => {
  const { store, create } = fixture(t);
  const existing = create();
  const before = structuredClone(store.state);
  const snapshot = readFileSync(join(store.dir, "state.json"), "utf8");
  for (const tasks of [
    [{ key: "same", title: "One" }, { key: "same", title: "Two" }],
    [{ key: "", title: "Empty key" }],
    [{ key: "@worker", title: "Invalid key" }],
    [{ key: "a".repeat(65), title: "Long key" }],
    [{ key: "worker\n", title: "Newline key" }],
    [{ key: null as unknown as string, title: "Null key" }],
    [{ title: "Unknown key", dependencies: ["@missing"] }],
    [{ key: "self", title: "Self", dependencies: ["@self"] }],
    [{ key: "a", title: "A", dependencies: ["@b"] }, { key: "b", title: "B", dependencies: ["@a"] }],
    [{ key: "a", title: "A" }, { title: "Duplicates", dependencies: ["@a", "@a"] }],
    [{ title: "Duplicates", dependencies: [existing.id, existing.id] }],
    [{ key: "worker", title: "Valid" }, { title: "Invalid", dependencies: ["missing"] }],
  ]) {
    assert.throws(() => store.task("root", { action: "create", tasks }));
    assert.deepEqual(store.state, before);
    assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), snapshot);
  }
  assert.throws(() => store.task("root", { action: "create", title: "Outside batch", dependencies: ["@worker"] }));
  assert.throws(() => store.task("root", { action: "create", tasks: [{ title: "Later batch", dependencies: ["@worker"] }] }));
});

test("start atomically claims ready work without stealing or reserving blocked work", t => {
  const { store, create } = fixture(t);
  const prerequisite = create();
  const blocked = create([prerequisite.id]);
  assert.throws(() => store.task("a", { action: "start", id: blocked.id }), /blocked/i);
  assert.equal(store.state.tasks[blocked.id].owner, undefined);
  assert.equal(store.state.tasks[blocked.id].revision, 1);
  assert.throws(() => store.task("a", { action: "start", id: prerequisite.id, revision: 99 }), /revision/i);
  const started = store.task("a", { action: "start", id: prerequisite.id, revision: 1 }) as TaskView;
  assert.equal(started.owner, "a");
  assert.equal(started.status, "in_progress");
  assert.equal(started.revision, 2);
  assert.throws(() => store.task("b", { action: "start", id: prerequisite.id }), /owner/i);
  assert.throws(() => store.task("a", { action: "complete", id: prerequisite.id }), /acceptance/i);
  store.task("a", { action: "complete", id: prerequisite.id, acceptance: true, summary: "Done" });
  store.task("b", { action: "start", id: blocked.id });
  assert.equal(store.state.tasks[blocked.id].owner, "b");
  assert.throws(() => store.task("a", { action: "start", id: prerequisite.id }), /to.do/i);
});

test("completion time persists for summary ordering and is cleared on reopen", t => {
  const { store, home, initial, create } = fixture(t);
  const task = create();
  store.task("a", { action: "claim", id: task.id });
  store.task("a", { action: "start", id: task.id });
  t.mock.method(Date, "now", () => 400);
  store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Done" });
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
  store.task("a", { action: "claim", id: task.id });
  assert.throws(() => store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Done" }), /in.progress/i);
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
  store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Done" });
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
  store.task("a", { action: "complete", id: prerequisite.id, acceptance: true, summary: "Done" });
  assert.throws(() => store.task("b", { action: "reopen", id: prerequisite.id }), /owner/i);
  const task = create([prerequisite.id]);
  store.task("b", { action: "claim", id: task.id });
  store.task("a", { action: "reopen", id: prerequisite.id });
  assert.throws(() => store.task("b", { action: "start", id: task.id }), /blocked/i);
  store.task("a", { action: "start", id: prerequisite.id });
  store.task("a", { action: "complete", id: prerequisite.id, acceptance: true, summary: "Done" });
  store.task("b", { action: "start", id: task.id });
  assert.throws(() => store.task("root", { action: "reopen", id: prerequisite.id }), /dependent/i);
  store.task("b", { action: "complete", id: task.id, acceptance: true, summary: "Done" });
  assert.throws(() => store.task("a", { action: "reopen", id: prerequisite.id }), /dependent/i);
});

test("new transitions honor revisions and survive restart with independent ownership", t => {
  const { store, create, home, initial } = fixture(t);
  const task = create();
  const claimed = store.task("a", { action: "claim", id: task.id }) as TaskView;
  assert.throws(() => store.task("a", { action: "start", id: task.id, revision: task.revision }), /revision/i);
  store.task("a", { action: "start", id: task.id, revision: claimed.revision });
  store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Done" });
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
  assert.equal(reopened.state.version, 5);
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

test("completion gates allow grounded work but block outcomes and completion watches", t => {
  const { store, create, home, initial } = fixture(t);
  const upstream = create();
  const task = store.task("root", { action: "create", title: "Integrate", completionDependencies: [upstream.id] }) as TaskView;
  assert.deepEqual(task.blockedBy, []);
  assert.deepEqual(task.completionBlockedBy, [upstream.id]);
  store.task("a", { action: "start", id: task.id });
  store.message("b", { action: "watch", tasks: [task.id] });
  const before = structuredClone(store.state);
  assert.throws(() => store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Premature" }), /completion.*blocked|blocked.*completion/i);
  assert.deepEqual(store.state, before);
  store.task("b", { action: "start", id: upstream.id });
  store.task("b", { action: "complete", id: upstream.id, acceptance: true, summary: "Verified upstream" });
  assert.deepEqual((store.task("a", { action: "read", id: task.id }) as TaskView).completionBlockedBy, []);
  store.close();
  const restored = new Store(initial, home);
  t.after(() => restored.close());
  assert.deepEqual((restored.task("a", { action: "read", id: task.id }) as TaskView).completionDependencies, [upstream.id]);
  const done = restored.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Integrated" }) as TaskView;
  assert.ok(restored.state.members.b.watches?.some(watch => watch.task === task.id && watch.seq));
  assert.equal(restored.state.messages.filter(message => message.task === task.id).length, 1);
  assert.equal((restored.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Integrated", revision: done.revision - 1 }) as TaskView).outcome, done.outcome);
});

test("both dependency kinds resolve forward keys and reject mixed invalid graphs atomically", t => {
  const { store, create } = fixture(t);
  const existing = create();
  for (const tasks of [
    [{ key: "a", title: "A", completionDependencies: ["@missing"] }],
    [{ key: "a", title: "A", completionDependencies: ["@a"] }],
    [{ key: "a", title: "A", completionDependencies: [existing.id, existing.id] }],
    [{ key: "a", title: "A", dependencies: [existing.id], completionDependencies: [existing.id] }],
    [{ key: "a", title: "A", dependencies: ["@b"] }, { key: "b", title: "B", completionDependencies: ["@a"] }],
  ]) {
    const before = structuredClone(store.state);
    assert.throws(() => store.task("root", { action: "create", tasks }), /reference|dependencies|cyclic/i);
    assert.deepEqual(store.state, before);
  }
  const result = store.task("root", { action: "create", tasks: [
    { key: "consumer", title: "Consumer", dependencies: [existing.id], completionDependencies: ["@producer"] },
    { key: "producer", title: "Producer" },
  ] });
  assert.ok("tasks" in result);
  assert.deepEqual(result.tasks[0].completionDependencies, [result.tasks[1].id]);
  assert.deepEqual(result.tasks[0].blockedBy, [existing.id]);
  assert.deepEqual(result.tasks[0].completionBlockedBy, [existing.id, result.tasks[1].id]);
});

test("completion edges preserve reservations, revisions, release and reopen invariants", t => {
  const { store, create } = fixture(t);
  const upstream = create();
  const task = create();
  const reserved = store.task("a", { action: "claim", id: task.id }) as TaskView;
  assert.throws(() => store.task("b", { action: "edit", id: task.id, completionDependencies: [upstream.id] }), /owner/i);
  store.task("a", { action: "edit", id: task.id, revision: reserved.revision, completionDependencies: [upstream.id] });
  assert.throws(() => store.task("a", { action: "edit", id: task.id, revision: reserved.revision, completionDependencies: [] }), /revision/i);
  assert.throws(() => store.task("root", { action: "edit", id: upstream.id, dependencies: [task.id] }), /cyclic/i);
  store.task("a", { action: "start", id: task.id });
  assert.throws(() => store.task("a", { action: "edit", id: task.id, completionDependencies: [] }), /to.do/i);
  store.task("a", { action: "release", id: task.id });
  store.task("a", { action: "start", id: task.id });
  store.task("b", { action: "start", id: upstream.id });
  store.task("b", { action: "complete", id: upstream.id, acceptance: true, summary: "Ready" });
  store.task("b", { action: "reopen", id: upstream.id });
  assert.deepEqual((store.task("a", { action: "read", id: task.id }) as TaskView).completionBlockedBy, [upstream.id]);
  store.task("b", { action: "start", id: upstream.id });
  store.task("b", { action: "complete", id: upstream.id, acceptance: true, summary: "Ready again" });
  store.task("a", { action: "complete", id: task.id, acceptance: true, summary: "Integrated" });
  assert.throws(() => store.task("root", { action: "reopen", id: upstream.id }), /dependent/i);
});

test("old snapshots omit completion edges and malformed new persisted edges are rejected", t => {
  const { store, create, home, initial } = fixture(t);
  const task = create();
  const path = join(store.dir, "state.json");
  store.close();
  const state = JSON.parse(readFileSync(path, "utf8"));
  delete state.tasks[task.id].completionDependencies;
  writeFileSync(path, JSON.stringify(state));
  const restored = new Store(initial, home);
  const view = restored.task("a", { action: "read", id: task.id }) as TaskView;
  assert.deepEqual(view.completionDependencies, []);
  assert.deepEqual(view.completionBlockedBy, []);
  restored.close();
  for (const refs of [null, "bad", [task.id], ["unknown"]]) {
    state.tasks[task.id].completionDependencies = refs;
    writeFileSync(path, JSON.stringify(state));
    assert.throws(() => new Store(initial, home), /dependencies/i);
  }
});

test("stored member network policies are validated on load", t => {
  const { store, home, initial } = fixture(t);
  const path = join(store.dir, "state.json");
  store.close();
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.members.a.access = { read: [home], write: [], network: { allow: ["not a host!"] } };
  writeFileSync(path, JSON.stringify(state));
  assert.throws(() => new Store(initial, home), /Invalid member access/);
});
