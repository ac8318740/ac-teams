import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, processAlive, processIdentity } from "../src/store.ts";
import type { TeamState, Task, Message } from "../src/types.ts";

function initial(): TeamState {
  return { version: 2, id: "team", root: "root", limit: 5, depth: 3, tasks: {}, messages: [], members: {
    root: { id: "root", depth: 0, token: "secret", cwd: "/tmp", status: "idle", notified: 0 },
    child: { id: "child", parent: "root", depth: 1, token: "secret2", cwd: "/tmp", status: "idle", notified: 0 },
    other: { id: "other", parent: "root", depth: 1, token: "secret3", cwd: "/tmp", status: "idle", notified: 0 },
  } };
}
function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "ac-store-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(initial(), home);
  t.after(() => store.close());
  return { home, store };
}

test("snapshot persists, locks exclude owners, and close is idempotent", t => {
  const { home, store } = fixture(t);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(store.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(store.dir, "state.json")).mode & 0o777, 0o600);
  assert.throws(() => new Store(initial(), home), /lock|owner/i);
  const task = store.task("root", { action: "create", title: "A", description: "B" }) as Task;
  store.close(); store.close();
  const reopened = new Store(initial(), home);
  assert.equal(reopened.state.tasks[task.id].title, "A");
  reopened.close();
});

test("failed mutations preserve memory and durable state; malformed snapshots are refused", t => {
  const { home, store } = fixture(t);
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  assert.throws(() => store.update(s => { s.limit = 0; }));
  assert.equal(store.state.limit, 5);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
  assert.throws(() => store.update(s => { s.limit = 9; throw new Error("failure"); }));
  assert.equal(store.state.limit, 5);
  store.close();
  writeFileSync(join(store.dir, "state.json"), "{}");
  assert.throws(() => new Store(initial(), home), /state|snapshot|schema/i);
  writeFileSync(join(store.dir, "state.json"), before);
  new Store(initial(), home).close();
});

test("task ownership, frozen edges, and interrupted-descendant release stay separate", t => {
  const { store } = fixture(t);
  const a = store.task("root", { action: "create", title: "A", description: "A" }) as Task;
  const b = store.task("root", { action: "create", title: "B", description: "B", dependencies: [a.id] }) as Task;
  store.task("child", { action: "claim", id: b.id });
  assert.throws(() => store.task("child", { action: "start", id: b.id }), /blocked/);
  assert.throws(() => store.task("root", { action: "edit", id: a.id, dependencies: [b.id] }));
  store.task("child", { action: "claim", id: a.id });
  assert.throws(() => store.task("other", { action: "claim", id: a.id }));
  assert.throws(() => store.task("root", { action: "release", id: a.id }));
  assert.throws(() => store.task("root", { action: "edit", id: a.id, dependencies: [] }));
  assert.throws(() => store.task("root", { action: "complete", id: a.id }));
  store.update(s => { s.members.child.status = "interrupted"; });
  assert.throws(() => store.task("other", { action: "release", id: a.id }));
  store.task("root", { action: "release", id: a.id });
  store.task("root", { action: "claim", id: a.id });
  store.task("root", { action: "start", id: a.id });
  assert.throws(() => store.task("root", { action: "complete", id: a.id }), /acceptance/);
  store.task("root", { action: "complete", id: a.id, acceptance: true });
  store.task("root", { action: "release", id: b.id });
  store.task("other", { action: "claim", id: b.id });
  assert.equal(store.state.tasks[b.id].owner, "other");
  assert.throws(() => store.task("unknown", { action: "list" }));
});

test("messages validate recipient sets atomically and provide bounded literal cursor searches", t => {
  const { store } = fixture(t);
  store.update(s => { s.members.other.status = "stopped"; });
  assert.throws(() => store.message("root", { action: "send", text: "no", recipients: ["child", "other"] }));
  assert.throws(() => store.message("root", { action: "send", text: "no", recipients: ["child", "child"] }));
  assert.equal(store.state.messages.length, 0);
  const first = store.message("root", { action: "send", text: "literal .*" }) as Message;
  assert.deepEqual(first.recipients, ["child"]);
  const second = store.message("child", { action: "send", text: "next" }) as Message;
  assert.equal(second.seq, first.seq + 1);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(store.message("other", { action: "search", query: ".*" }), [first]);
  assert.deepEqual(store.message("other", { action: "history", after: first.seq, limit: 1 }), [second]);
  assert.throws(() => store.message("root", { action: "send", text: "x".repeat(16001) }));
  assert.throws(() => store.message("root", { action: "history", limit: 101 }));
});

test("paths and process locks fail closed", t => {
  const { home, store } = fixture(t);
  assert.throws(() => new Store({ ...initial(), id: "../escape" }, home));
  const alias = join(home, "alias");
  symlinkSync(store.dir, alias);
  assert.throws(() => new Store({ ...initial(), id: "alias" }, home));
  assert.equal(processAlive(process.pid, processIdentity(process.pid)), true);
  assert.equal(processAlive(process.pid, "wrong identity"), false);
  assert.throws(() => processAlive(-1));
  store.close();
  writeFileSync(join(store.dir, "owner.lock"), JSON.stringify({ pid: process.pid, identity: "old" }), { mode: 0o600 });
  const recovered = new Store(initial(), home);
  recovered.close();
  writeFileSync(join(store.dir, "owner.lock"), "uncertain", { mode: 0o600 });
  assert.throws(() => new Store(initial(), home));
  assert.equal(readFileSync(join(store.dir, "owner.lock"), "utf8"), "uncertain");
});

test("a dead owner is recovered without losing its task claims", t => {
  const home = mkdtempSync(join(tmpdir(), "ac-crash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const module = new URL("../src/store.ts", import.meta.url).href;
  const script = `import { Store } from ${JSON.stringify(module)};
    const store = new Store(${JSON.stringify(initial())}, ${JSON.stringify(home)});
    const task = store.task('child', { action: 'create', title: 'A', description: 'B' });
    store.task('child', { action: 'claim', id: task.id });
    console.log(JSON.stringify({ pid: process.pid, id: task.id }));
    process.exit(0);`;
  const { pid, id } = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.equal(processAlive(pid), false);
  assert.equal(processIdentity(pid), undefined);
  const recovered = new Store(initial(), home);
  t.after(() => recovered.close());
  assert.equal(recovered.state.tasks[id].status, "todo");
  assert.equal(recovered.state.tasks[id].owner, "child");
  assert.throws(() => recovered.task("root", { action: "claim", id }));
});

test("unsafe snapshot destinations fail without changing memory or exposing files", t => {
  const { store, home } = fixture(t);
  const snapshot = join(store.dir, "state.json");
  const outside = join(home, "unrelated");
  writeFileSync(outside, "do not change", { mode: 0o644 });
  rmSync(snapshot);
  symlinkSync(outside, snapshot);
  assert.throws(() => store.update(s => { s.limit = 7; }));
  assert.equal(store.state.limit, 5);
  assert.equal(readFileSync(outside, "utf8"), "do not change");
  assert.equal(statSync(outside).mode & 0o777, 0o644);
});

test("task and message results stay bounded", t => {
  const { store } = fixture(t);
  store.update(s => {
    for (let i = 0; i < 105; i++) {
      const id = `task-${i}`;
      s.tasks[id] = { id, revision: 1, title: "A", description: "B", dependencies: [], status: "todo" };
      s.messages.push({ seq: i + 1, id: `message-${i}`, from: "root", recipients: ["child"], text: "text", time: new Date().toISOString() });
    }
  });
  const tasks = store.task("root", { action: "list" }) as { tasks: Task[]; total: number };
  assert.equal(tasks.total, 105);
  assert.equal(tasks.tasks.length, 100);
  const next = store.task("root", { action: "list", offset: 100 }) as { tasks: Task[]; total: number };
  assert.equal(next.tasks.length, 5);
  assert.equal(next.tasks[0].id, "task-100");
  assert.throws(() => store.task("root", { action: "list", offset: -1 }));
  assert.equal((store.message("root", { action: "history" }) as Message[]).length, 20);
  assert.equal((store.message("root", { action: "history", limit: 100 }) as Message[]).length, 100);
  assert.equal((store.message("root", { action: "history", after: 100, limit: 100 }) as Message[]).length, 5);
  assert.throws(() => store.task("root", { action: "create", title: "", description: "B" }));
  assert.throws(() => store.task("root", { action: "create", title: "A", description: "B", dependencies: ["missing"] }));
  assert.throws(() => store.task("root", { action: "edit", id: "task-0", dependencies: ["task-0"] }));
});

test("optional revision checks reject stale task mutations and completion requires acceptance", t => {
  const { store } = fixture(t);
  const created = store.task("root", { action: "create", title: "A", description: "B" }) as Task;
  const edited = store.task("root", { action: "edit", id: created.id, revision: created.revision, title: "Edited" }) as Task;
  assert.equal(edited.revision, created.revision + 1);
  assert.throws(() => store.task("child", { action: "claim", id: created.id, revision: created.revision }), /revision/i);
  assert.throws(() => store.task("root", { action: "edit", id: created.id, revision: created.revision, title: "Stale" }), /revision/i);
  const claimed = store.task("child", { action: "claim", id: created.id, revision: edited.revision }) as Task;
  assert.equal(claimed.revision, edited.revision + 1);
  assert.throws(() => store.task("child", { action: "release", id: created.id, revision: edited.revision }), /revision/i);
  assert.throws(() => store.task("child", { action: "complete", id: created.id, revision: edited.revision, acceptance: true }), /revision/i);
  assert.throws(() => store.task("child", { action: "complete", id: created.id, acceptance: true }), /in-progress/i);
  const started = store.task("child", { action: "start", id: created.id, revision: claimed.revision }) as Task;
  assert.throws(() => store.task("child", { action: "complete", id: created.id, revision: started.revision }), /acceptance/i);
  assert.throws(() => store.task("child", { action: "complete", id: created.id, acceptance: false }), /acceptance/i);
  assert.equal(store.state.tasks[created.id].revision, started.revision);
  const completed = store.task("child", { action: "complete", id: created.id, revision: started.revision, acceptance: true }) as Task;
  assert.equal(completed.status, "done");
  assert.equal(completed.revision, started.revision + 1);
});
