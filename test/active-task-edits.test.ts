import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/team/store.ts";
import type { TaskArgs, TaskView, TeamState, WatchResult } from "../src/types.ts";

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "ac-active-edits-"));
  const initial: TeamState = { version: 5, id: "team", key: "key", limit: 5, depth: 3, tasks: {}, messages: [], members: Object.fromEntries(["root", "owner", "dependent", "subscriber", "unrelated"].map(id => [id, { id, role: id === "root" ? "main" : "member", depth: 0, token: id, cwd: home, status: "idle", notified: 0 }])) };
  const store = new Store(initial, home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const create = (title = "Work", fields: Partial<TaskArgs> = {}) => store.task("root", { action: "create", title, ...fields }) as TaskView;
  return { store, home, initial, create };
}

test("active metadata edits are owned, effective, revision-safe, and done remains immutable", t => {
  const { store, create } = fixture(t);
  const task = create();
  const active = store.task("owner", { action: "start", id: task.id }) as TaskView;
  const before = structuredClone(store.state);
  assert.throws(() => store.task("root", { action: "edit", id: task.id, title: "Steal" }), /owner/);
  assert.deepEqual(store.state, before);
  const edited = store.task("owner", { action: "edit", id: task.id, revision: active.revision, title: "New goal", description: "New criteria", label: "New label" }) as TaskView;
  assert.equal(edited.title, "New goal");
  assert.equal(edited.description, "New criteria");
  assert.equal(edited.label, "New label");
  assert.equal(edited.status, "in_progress");
  assert.equal(edited.revision, active.revision + 1);
  assert.match(store.state.messages.at(-1)!.summary, /title.*Work.*New goal/);
  assert.throws(() => store.task("owner", { action: "edit", id: task.id, revision: active.revision, title: "Stale" }), /revision/);
  const count = store.state.messages.length;
  assert.equal((store.task("owner", { action: "edit", id: task.id, title: "New goal" }) as TaskView).revision, edited.revision);
  assert.equal(store.state.messages.length, count);
  store.task("owner", { action: "complete", id: task.id, acceptance: true, summary: "Checked" });
  const done = structuredClone(store.state);
  assert.throws(() => store.task("owner", { action: "edit", id: task.id, description: "Rewrite accepted result" }), /done|reopen/);
  assert.deepEqual(store.state, done);
});

for (const field of ["dependencies", "completionDependencies"] as const) test(`active ${field} additions warn, persist and block completion without stopping work`, t => {
  const { store, home, initial, create } = fixture(t);
  const task = create(), upstream = create("Upstream");
  store.task("owner", { action: "start", id: task.id });
  const edited = store.task("owner", { action: "edit", id: task.id, [field]: [upstream.id] }) as TaskView;
  assert.deepEqual(edited.completionBlockedBy, [upstream.id]);
  assert.equal(edited.status, "in_progress");
  assert.ok(edited.warnings?.some(warning => warning.includes(field)));
  assert.match(edited.warnings!.join(" "), /grounded.*pause.*unsound/);
  assert.match(store.state.messages.at(-1)!.summary, /completion blocked/);
  const before = structuredClone(store.state);
  assert.throws(() => store.task("owner", { action: "complete", id: task.id, acceptance: true, summary: "Premature" }), /blocked/);
  assert.deepEqual(store.state, before);
  store.close();
  const restored = new Store(initial, home);
  t.after(() => restored.close());
  assert.equal(restored.state.tasks[task.id].status, "in_progress");
  assert.deepEqual((restored.task("owner", { action: "read", id: task.id }) as TaskView).completionBlockedBy, [upstream.id]);
  restored.task("dependent", { action: "start", id: upstream.id });
  restored.task("dependent", { action: "complete", id: upstream.id, acceptance: true, summary: "Verified" });
  restored.task("owner", { action: "complete", id: task.id, acceptance: true, summary: "Integrated" });
  assert.throws(() => restored.task("root", { action: "reopen", id: upstream.id }), /dependents/);
});

for (const active of [false, true]) test(`${active ? "active" : "todo"} removals require current owner confirmation of exact revision and replacement`, t => {
  const { store, create } = fixture(t);
  const upstream = create("Upstream"), replacement = create("Replacement");
  const task = create("Consumer", { completionDependencies: [upstream.id] });
  const confirm = { confirmDependencyRemoval: true };
  let before = structuredClone(store.state);
  assert.throws(() => store.task("root", { action: "edit", id: task.id, revision: task.revision, completionDependencies: [], ...confirm }), /owner|claim/);
  assert.deepEqual(store.state, before);
  store.task("owner", { action: active ? "start" : "claim", id: task.id });
  for (const next of [[], [replacement.id]]) {
    const current = store.state.tasks[task.id].revision;
    before = structuredClone(store.state);
    for (const extra of [{}, confirm, { ...confirm, revision: current - 1 }, { revision: current }]) {
      assert.throws(() => store.task("owner", { action: "edit", id: task.id, completionDependencies: next, ...extra }), /confirm|revision/);
      assert.deepEqual(store.state, before);
    }
    store.task("owner", { action: "edit", id: task.id, completionDependencies: next, revision: current, ...confirm });
    assert.deepEqual(store.state.tasks[task.id].completionDependencies, next);
    if (next.length) {
      const notice = store.state.messages.at(-1)!.summary;
      assert.ok(notice.includes(`added 1 (#${replacement.number})`), notice);
      assert.ok(notice.includes(`removed 1 (#${upstream.number})`), notice);
    }
    // Restore an edge through an addition; the next iteration then tests replacement.
    store.task("owner", { action: "edit", id: task.id, completionDependencies: [upstream.id, ...next] });
  }
});

test("large dependency notices bound references and disclose omitted counts", t => {
  const { store, create } = fixture(t);
  const task = create(), upstream = Array.from({ length: 12 }, (_, i) => create(`Upstream ${i}`));
  store.task("owner", { action: "start", id: task.id });
  store.task("owner", { action: "edit", id: task.id, dependencies: upstream.map(task => task.id) });
  const notice = store.state.messages.at(-1)!.summary;
  assert.ok(notice.includes(`added 12 (#${upstream.slice(0, 10).map(task => task.number).join(", #")}, +2 more)`), notice);
  assert.ok(notice.length < 1000);
});

test("invalid active graphs roll back both edits and notifications; reordered edges are no-ops", t => {
  const { store, create } = fixture(t);
  const task = create(), a = create("A"), b = create("B", { completionDependencies: [task.id] });
  store.task("owner", { action: "start", id: task.id });
  for (const fields of [{ dependencies: [task.id] }, { dependencies: ["missing"] }, { dependencies: [a.id, a.id] }, { dependencies: [a.id], completionDependencies: [a.id] }, { completionDependencies: [b.id] }]) {
    const before = structuredClone(store.state), bytes = readFileSync(join(store.dir, "state.json"), "utf8");
    assert.throws(() => store.task("owner", { action: "edit", id: task.id, ...fields }), /dependencies|cyclic/);
    assert.deepEqual(store.state, before);
    assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), bytes);
  }
  const c = create("C");
  const edited = store.task("owner", { action: "edit", id: task.id, dependencies: [a.id, c.id] }) as TaskView;
  const before = structuredClone(store.state);
  assert.equal((store.task("owner", { action: "edit", id: task.id, dependencies: [c.id, a.id] }) as TaskView).revision, edited.revision);
  assert.deepEqual(store.state, before);
});

test("edit posts deduplicate both dependent edge kinds and persistent subscribers without broadcasting", t => {
  const { store, create } = fixture(t);
  const task = create();
  for (const field of ["dependencies", "completionDependencies"] as const) {
    const downstream = create("Downstream", { [field]: [task.id] });
    store.task("dependent", { action: "claim", id: downstream.id });
  }
  store.message("dependent", { action: "watch", tasks: [task.id], event: "edited" });
  store.message("subscriber", { action: "watch", tasks: [task.id], event: "edited" });
  store.message("subscriber", { action: "watch", tasks: [task.id], event: "message" });
  store.message("unrelated", { action: "watch", tasks: [task.id] });
  store.task("owner", { action: "start", id: task.id });
  store.task("owner", { action: "edit", id: task.id, title: "Changed" });
  const first = store.state.messages.at(-1)!;
  assert.equal(first.kind, "edited");
  assert.deepEqual([...first.recipients].sort(), ["dependent", "root", "subscriber"]);
  assert.equal(store.state.members.subscriber.watches?.find(w => w.event === "message")?.seq, first.seq);
  assert.equal(store.state.members.subscriber.watches?.find(w => w.event === "edited")?.seq, undefined);
  assert.equal(store.state.members.unrelated.watches?.[0].seq, undefined);
  store.task("owner", { action: "edit", id: task.id, description: "Changed criteria" });
  assert.ok(store.state.messages.at(-1)!.recipients.includes("subscriber"));
  assert.equal(store.state.members.subscriber.watches?.find(w => w.event === "message")?.seq, first.seq);
});

test("edited subscriptions catch up and persist, cancel precisely, stay bounded and isolate teams", t => {
  const { store, home, initial, create } = fixture(t);
  const task = create();
  store.task("root", { action: "edit", id: task.id, title: "First" });
  const subscribed = store.message("subscriber", { action: "watch", tasks: [task.id], event: "edited", after: 0 }) as WatchResult;
  assert.equal(subscribed.updates.length, 1);
  assert.deepEqual(subscribed.watching, [{ task: task.id, event: "edited" }]);
  store.message("subscriber", { action: "watch", tasks: [task.id], event: "edited" });
  assert.equal(store.state.members.subscriber.watches?.length, 1);
  assert.throws(() => store.message("subscriber", { action: "wait", tasks: [task.id], event: "edited" }), /watch|wait/);
  store.close();
  const restored = new Store(initial, home);
  t.after(() => restored.close());
  restored.task("root", { action: "edit", id: task.id, title: "Second" });
  assert.ok(restored.state.messages.at(-1)!.recipients.includes("subscriber"));
  restored.message("subscriber", { action: "unwatch", tasks: [task.id], event: "completed" });
  assert.equal(restored.state.members.subscriber.watches?.length, 1);
  restored.message("subscriber", { action: "unwatch", tasks: [task.id], event: "edited" });
  restored.task("root", { action: "edit", id: task.id, title: "Third" });
  assert.ok(!restored.state.messages.at(-1)!.recipients.includes("subscriber"));
  const others = Array.from({ length: 100 }, (_, i) => restored.task("root", { action: "create", title: `Task ${i}` }) as TaskView);
  restored.message("subscriber", { action: "watch", tasks: others.map(task => task.id), event: "edited" });
  const before = structuredClone(restored.state);
  assert.throws(() => restored.message("subscriber", { action: "watch", tasks: [task.id], event: "edited" }), /100/);
  assert.deepEqual(restored.state, before);
  const isolated = new Store({ ...initial, id: "another" }, join(home, "isolated"));
  t.after(() => isolated.close());
  assert.equal(isolated.state.members.subscriber.watches, undefined);
});
