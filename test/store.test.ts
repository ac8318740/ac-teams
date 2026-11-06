import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { Store } from "../src/team/store.ts";
import { processAlive, processIdentity } from "../src/process.ts";
import { createMemberLabels } from "../src/team/snapshot.ts";
import type { TeamState, Task, Message } from "../src/types.ts";

function initial(): TeamState {
  return { version: 5, id: "team", key: "key", limit: 5, depth: 3, tasks: {}, messages: [], members: {
    root: { id: "root", role: "main", depth: 0, token: "secret", cwd: "/tmp", status: "idle", notified: 0 },
    child: { id: "child", role: "member", parent: "root", depth: 1, token: "secret2", cwd: "/tmp", status: "idle", notified: 0 },
    other: { id: "other", role: "member", parent: "root", depth: 1, token: "secret3", cwd: "/tmp", status: "idle", notified: 0 },
  } };
}
function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "ac-store-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(initial(), home);
  t.after(() => store.close());
  return { home, store };
}

test("durable records and process helpers load without Pi runtime dependencies", () => {
  const hook = `export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@earendil-works/') || specifier.startsWith('@mariozechner/')) throw new Error('Unexpected Pi runtime dependency: ' + specifier);
    return next(specifier, context);
  }`;
  const script = `import { register } from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);
    await import(${JSON.stringify(new URL("../src/team/store.ts", import.meta.url).href)});
    await import(${JSON.stringify(new URL("../src/process.ts", import.meta.url).href)});`;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "pipe" });
});

test("task watches persist, distinguish completion from messages, and can be cancelled", t => {
  const { store } = fixture(t);
  const task = store.task("child", { action: "create", title: "Build" }) as Task;
  store.message("other", { action: "watch", tasks: [task.id] });
  store.message("other", { action: "watch", tasks: [task.id] });
  assert.equal(store.state.members.other.watches?.length, 1, "registration is idempotent");
  const progress = store.message("child", { action: "send", task: task.id, summary: "Working" }) as Message;
  assert.ok(!progress.recipients.includes("other"), "progress does not consume a completion watch");
  const unrelated = store.message("root", { action: "send", recipients: ["other"], summary: "Another question" }) as Message;
  assert.ok(unrelated.recipients.includes("other"));
  assert.equal(store.state.members.other.watches?.[0].seq, undefined);
  store.task("child", { action: "start", id: task.id });
  store.task("child", { action: "complete", id: task.id, acceptance: true, summary: "Built and checked" });
  const outcome = store.state.messages.at(-1)!;
  assert.ok(outcome.recipients.includes("other"));
  assert.equal(store.state.members.other.watches?.[0].seq, outcome.seq, "retain triggered registration until delivery acknowledgement");
  const later = store.message("child", { action: "send", task: task.id, summary: "More context" }) as Message;
  assert.ok(!later.recipients.includes("other"), "a one-shot watch triggers only once");
  store.message("other", { action: "unwatch", tasks: [task.id] });
  assert.deepEqual(store.state.members.other.watches, []);
});

test("watch catch-up is atomic, preserves other registrations, and validates tasks", t => {
  const { store } = fixture(t);
  const a = store.task("child", { action: "create", title: "A" }) as Task;
  const b = store.task("child", { action: "create", title: "B" }) as Task;
  store.message("other", { action: "watch", tasks: [b.id] });
  const posted = store.message("child", { action: "send", task: a.id, summary: "Ready" }) as Message;
  const result = store.message("other", { action: "watch", tasks: [a.id], event: "message", after: 0 }) as { updates: Message[] };
  assert.deepEqual(result.updates.map(m => m.seq), [posted.seq]);
  assert.deepEqual(store.state.members.other.watches?.map(w => w.task), [b.id]);
  store.task("child", { action: "start", id: a.id });
  store.task("child", { action: "complete", id: a.id, acceptance: true, summary: "A checked" });
  const done = store.message("other", { action: "watch", tasks: [a.id] }) as { updates: Message[] };
  assert.equal(done.updates[0].kind, "outcome", "already-completed tasks return immediately");
  store.update(state => { delete state.messages.find(message => message.id === state.tasks[a.id].outcome)!.kind; });
  const legacy = store.message("other", { action: "watch", tasks: [a.id] }) as { watching: unknown[]; updates: Message[] };
  assert.equal(legacy.updates.length, 1);
  assert.equal(legacy.watching.length, 1, "legacy outcome without kind must not leave a completion watch on A");
  assert.deepEqual(store.state.members.other.watches?.map(w => w.task), [b.id]);
  assert.throws(() => store.message("other", { action: "watch", tasks: ["missing"] }), /existing task/);
  assert.throws(() => store.message("other", { action: "watch", tasks: [] }), /1-100/);
  store.message("other", { action: "unwatch" });
  assert.deepEqual(store.state.members.other.watches, []);
});

test("member labels reuse unchanged snapshots and refresh after writes, team switches, and unsafe replacements", t => {
  const { store } = fixture(t);
  const labels = createMemberLabels();
  const first = labels(store.dir);
  assert.equal(first.root, "Main");
  assert.equal(labels(store.dir), first, "unchanged state reuses labels rather than rereading history");
  store.update(state => { state.members.child.name = "reviewer"; });
  const next = labels(store.dir);
  assert.notEqual(next, first);
  assert.equal(next.child, "reviewer");
  assert.equal(labels(store.dir), next);
  const other = new Store({ ...initial(), id: "other-team" }, join(store.dir, "other"));
  t.after(() => other.close());
  other.update(state => { state.members.child.name = "writer"; });
  assert.equal(labels(other.dir).child, "writer");
  assert.equal(labels(store.dir).child, "reviewer", "do not reuse labels across teams");
  const file = join(store.dir, "state.json");
  rmSync(file); symlinkSync(join(other.dir, "state.json"), file);
  assert.throws(() => labels(store.dir), /ELOOP|Unsafe/);
  rmSync(file); writeFileSync(file, "{}", { mode: 0o600 });
  assert.throws(() => labels(store.dir), /state|snapshot|schema/i);
});

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

test("analysis preferences persist while older snapshots remain readable", t => {
  const { home, store } = fixture(t);
  assert.equal(store.state.members.child.analysis, undefined, "old snapshots have no analysis preference");
  const path = join(store.dir, "state.json");
  store.update(state => { state.members.child.analysis = "separate"; });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).members.child.analysis, "separate");
  store.close();
  const reopened = new Store(initial(), home);
  try {
    assert.equal(reopened.state.members.child.analysis, "separate");
    assert.equal(reopened.state.members.other.analysis, undefined);
  } finally { reopened.close(); }
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.members.child.analysis = "shared";
  writeFileSync(path, JSON.stringify(saved));
  assert.throws(() => new Store(initial(), home), /Invalid member analysis preference/);
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

for (const failure of ["file sync", "rename", "directory sync"]) {
  test(`completion remains atomic when snapshot ${failure} fails`, t => {
    const { home, store } = fixture(t);
    const task = store.task("child", { action: "create", title: "Build" }) as Task;
    store.task("child", { action: "start", id: task.id });
    store.message("other", { action: "watch", tasks: [task.id] });
    const before = structuredClone(store.state);
    const snapshot = join(store.dir, "state.json");
    const bytes = readFileSync(snapshot, "utf8");
    const sync = fs.fsyncSync;
    let syncs = 0;
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      syncs++;
      if (syncs === (failure === "file sync" ? 1 : 2) && failure !== "rename") throw new Error(`Injected ${failure} failure`);
      sync(fd);
    });
    if (failure === "rename") t.mock.method(fs, "renameSync", () => { throw new Error("Injected rename failure"); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => store.task("child", { action: "complete", id: task.id, acceptance: true, summary: "Built and checked" }), /Injected/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(store.state, before, "failed flush never publishes the draft in memory");
    assert.ok(!readdirSync(store.dir).some(name => name.startsWith(".state-")), "failed flush cleans its temporary file");
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    if (failure !== "directory sync") assert.equal(readFileSync(snapshot, "utf8"), bytes);
    store.close();
    const reopened = new Store(initial(), home);
    try {
      assert.equal(reopened.state.tasks[task.id].status, failure === "directory sync" ? "done" : "in_progress", "rename precedes directory fsync, so that failure may leave the new snapshot");
      reopened.task("child", { action: "complete", id: task.id, acceptance: true, summary: "Built and checked" });
      const durable = JSON.parse(readFileSync(snapshot, "utf8")) as TeamState;
      assert.deepEqual(durable, reopened.state);
      const outcomes = durable.messages.filter(message => message.kind === "outcome");
      assert.equal(outcomes.length, 1, "retry never duplicates the completion post");
      assert.equal(durable.tasks[task.id].outcome, outcomes[0].id);
      assert.equal(durable.tasks[task.id].status, "done");
      assert.equal(durable.members.other.watches?.[0].seq, outcomes[0].seq);
      assert.ok(outcomes[0].recipients.includes("other"));
    } finally { reopened.close(); }
  });
}

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
  store.task("root", { action: "complete", id: a.id, acceptance: true, summary: "A done" });
  store.task("root", { action: "release", id: b.id });
  store.task("other", { action: "claim", id: b.id });
  assert.equal(store.state.tasks[b.id].owner, "other");
  assert.throws(() => store.task("unknown", { action: "list" }));
});

test("posts route to named recipients, never broadcast, and provide bounded literal cursor searches", t => {
  const { store } = fixture(t);
  store.update(s => { s.members.other.status = "stopped"; });
  assert.throws(() => store.message("root", { action: "send", summary: "no", recipients: ["child", "unknown"] }), /known member/);
  assert.throws(() => store.message("root", { action: "send", summary: "no", recipients: ["child", "child"] }));
  assert.throws(() => store.message("root", { action: "send", summary: "no" }), /never broadcast/);
  assert.equal(store.state.messages.length, 0);
  const first = store.message("root", { action: "send", summary: "literal .*", recipients: ["root", "child", "other"] }) as Message;
  assert.deepEqual(first.recipients, ["child", "other"], "a stopped recipient keeps its post; the sender is excluded");
  const second = store.message("child", { action: "send", summary: "next", replyTo: first.id }) as Message;
  assert.deepEqual(second.recipients, ["root"], "a reply reaches the replied-to author");
  assert.equal(second.seq, first.seq + 1);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(store.message("other", { action: "search", query: ".*" }), [first]);
  assert.deepEqual(store.message("other", { action: "history", after: first.seq, limit: 1 }), [second]);
  assert.throws(() => store.message("root", { action: "send", recipients: ["child"], summary: "x".repeat(16001) }));
  assert.throws(() => store.message("root", { action: "history", limit: 101 }));
});

test("message reads filter by task and exact sequence before pagination without consuming notices", t => {
  const { store } = fixture(t);
  const task = store.task("root", { action: "create", title: "Parser" }) as Task;
  store.message("root", { action: "send", recipients: ["child"], summary: "Unrelated" });
  const first = store.message("root", { action: "send", task: task.id, recipients: ["child"], summary: "Review", detail: "Boundary evidence" }) as Message;
  const second = store.message("child", { action: "send", replyTo: first.id, summary: "Fixed" }) as Message;
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  assert.deepEqual(store.message("child", { action: "history", task: task.id, limit: 1 }), [first]);
  assert.deepEqual(store.message("child", { action: "history", task: task.id, after: first.seq }), [second]);
  assert.deepEqual(store.message("child", { action: "history", seq: first.seq }), [first]);
  assert.deepEqual(store.message("child", { action: "search", task: task.id, query: "Boundary" }), [first]);
  assert.deepEqual(store.message("child", { action: "search", seq: first.seq, query: "Fixed" }), []);
  assert.deepEqual(store.message("child", { action: "history", seq: first.seq, after: first.seq }), []);
  assert.deepEqual(store.message("child", { action: "history", seq: 999 }), []);
  assert.throws(() => store.message("child", { action: "history", task: "missing" }), /existing task/);
  assert.throws(() => store.message("child", { action: "history", seq: 0 }), /sequence/);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
});

test("message aliases resolve to durable IDs and reject invalid sets atomically", t => {
  const { store } = fixture(t);
  store.update(s => { s.members.child.name = "oom-review"; s.members.other.name = "tests"; });
  const sent = store.message("root", { action: "send", recipients: ["oom-review", "other"], summary: "Review" }) as Message;
  assert.deepEqual(sent.recipients, ["child", "other"]);
  assert.deepEqual(store.state.messages[0], sent);
  assert.deepEqual(JSON.parse(readFileSync(join(store.dir, "state.json"), "utf8")).messages[0].recipients, ["child", "other"]);
  assert.deepEqual((store.message("child", { action: "send", recipients: ["root"], summary: "Done" }) as Message).recipients, ["root"]);
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  for (const recipients of [["child", "oom-review"], ["oom-review", "oom-review"], ["oom-review", "missing"], ["OOM-review"], ["toString"]]) {
    assert.throws(() => store.message("root", { action: "send", recipients, summary: "No" }), /Recipients/);
    assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
  }
  store.update(s => { s.members.child.status = "stopped"; });
  assert.deepEqual((store.message("root", { action: "send", recipients: ["oom-review"], summary: "On resume" }) as Message).recipients, ["child"], "a stopped member keeps its post for resume");
});

test("task posts reach owner and delegator; completion publishes its outcome atomically and idempotently", t => {
  const { home, store } = fixture(t);
  const task = store.task("root", { action: "create", title: "A", description: "A" }) as Task;
  store.update(s => { s.tasks[task.id].owner = "child"; s.tasks[task.id].delegator = "other"; });
  const question = store.message("child", { action: "send", summary: "Which parser?", task: task.id }) as Message;
  assert.deepEqual(question.recipients, ["other"], "the delegator, not the creator, receives the owner's question");
  const answer = store.message("other", { action: "send", summary: "The new one", replyTo: question.id }) as Message;
  assert.equal(answer.task, task.id, "a reply inherits its task");
  assert.deepEqual(answer.recipients, ["child"]);
  const other = store.task("root", { action: "create", title: "B", description: "B" }) as Task;
  assert.throws(() => store.message("other", { action: "send", summary: "x", replyTo: question.id, task: other.id }), /stays on/);
  store.task("child", { action: "start", id: task.id });
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  assert.throws(() => store.task("child", { action: "complete", id: task.id, acceptance: true }), /outcome summary/);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before, "a refused completion writes nothing");
  const done = store.task("child", { action: "complete", id: task.id, acceptance: true, summary: "Parsed", detail: "All 12 cases" }) as Task;
  const outcome = store.state.messages.at(-1)!;
  assert.equal(done.outcome, outcome.id);
  assert.deepEqual([outcome.summary, outcome.detail, outcome.task, outcome.recipients], ["Parsed", "All 12 cases", task.id, ["other"]]);
  const count = store.state.messages.length;
  assert.deepEqual(store.task("child", { action: "complete", id: task.id, acceptance: true, summary: "Parsed", detail: "All 12 cases" }), done, "a retry returns the original");
  assert.throws(() => store.task("child", { action: "complete", id: task.id, acceptance: true, summary: "Different" }), /different outcome/);
  assert.equal(store.state.messages.length, count);
  store.task("child", { action: "reopen", id: task.id });
  assert.equal(store.state.tasks[task.id].outcome, undefined);
  assert.equal(store.state.messages.length, count, "reopening keeps the published post");
  store.close();
  const reopened = new Store(initial(), home);
  assert.equal(reopened.state.tasks[task.id].delegator, "other");
  reopened.close();
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

test("an exited but unreaped process is not alive or an owned signal target", { timeout: 10000 }, async () => {
  const parent = spawn(process.execPath, ["-e", `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    child.once('exit', () => process.exit(0));
    console.log(child.pid);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(parent, "exit");
  let pid: number | undefined;
  try {
    const [output] = await once(parent.stdout!, "data");
    pid = Number(String(output).trim());
    const identity = processIdentity(pid);
    assert.ok(identity);
    assert.equal(processAlive(pid, identity), true);
    parent.kill("SIGSTOP");
    // Wait until the parent cannot reap its child, reproducing tmux's zombie leader.
    for (let i = 0; i < 200; i++) {
      if (readFileSync(`/proc/${parent.pid}/stat`, "utf8").split(") ")[1].startsWith("T ")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(readFileSync(`/proc/${parent.pid}/stat`, "utf8").split(") ")[1], /^T /);
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 200; i++) {
      if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z ")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1], /^Z /);
    assert.equal(processAlive(pid), false);
    assert.equal(processAlive(pid, identity), false);
    assert.equal(processIdentity(pid), undefined);
  } finally {
    if (pid && processAlive(pid)) process.kill(pid, "SIGKILL");
    parent.kill("SIGCONT");
    await exited;
  }
});

test("a dead owner is recovered without losing its task claims", t => {
  const home = mkdtempSync(join(tmpdir(), "ac-crash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const module = new URL("../src/team/store.ts", import.meta.url).href;
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
      s.tasks[id] = { id, number: i + 1, label: "A", revision: 1, title: "A", description: "B", dependencies: [], status: "todo" };
      s.messages.push({ seq: i + 1, id: `message-${i}`, from: "root", recipients: ["child"], summary: "text", time: new Date().toISOString() });
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

test("task numbers and concise labels survive edits, failures, pagination, and restart", t => {
  const { home, store } = fixture(t);
  const first = store.task("root", { action: "create", label: "Parser tests", title: "Run every parser acceptance check", description: "All cases pass" }) as Task;
  const second = store.task("root", { action: "create", title: "Ship parser", description: "Check the final result", dependencies: [first.id] }) as Task;
  assert.deepEqual([first.number, first.label, second.number, second.label], [1, "Parser tests", 2, "Ship parser"]);
  const edited = store.task("root", { action: "edit", id: first.id, label: "Parser review", title: "Check the whole parser implementation" }) as Task;
  assert.equal(edited.number, 1);
  assert.equal(edited.label, "Parser review");
  const page = store.task("root", { action: "list", offset: 1, limit: 1 });
  assert.ok("tasks" in page);
  assert.deepEqual(page.tasks.map(task => task.number), [2]);
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  for (const label of ["", "one two three four", "one\ntwo", "one\ttwo", "one  two", "x".repeat(61), "bad\x1b[31m"]) {
    assert.throws(() => store.task("root", { action: "create", title: "Valid", label, description: "Do it" }), /label/i);
    assert.throws(() => store.task("root", { action: "edit", id: first.id, label }), /label/i);
  }
  assert.throws(() => store.update(state => { state.tasks[second.id].number = first.number; }), /number/i);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
  store.close();
  const reopened = new Store(initial(), home);
  try {
    assert.equal(reopened.state.tasks[first.id].number, 1);
    assert.equal(reopened.state.tasks[first.id].label, "Parser review");
    const third = reopened.task("root", { action: "create", title: "解析器 テスト", description: "Independent task" }) as Task;
    assert.equal(third.number, 3);
    assert.deepEqual(third.dependencies, [], "new tasks must not gain invented dependencies");
    assert.equal(reopened.state.tasks[second.id].dependencies[0], first.id);
  } finally { reopened.close(); }
});

test("schema 3 migrates the root record to a main session and every other record to a member", t => {
  const { home, store } = fixture(t);
  store.task("child", { action: "create", title: "Keep me", description: "Survives migration" });
  const path = join(store.dir, "state.json");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  store.close();
  Object.assign(legacy, { version: 3, root: "root" });
  delete legacy.key;
  for (const member of Object.values(legacy.members) as Record<string, unknown>[]) delete member.role;
  writeFileSync(path, JSON.stringify(legacy));
  const reopened = new Store(initial(), home);
  t.after(() => reopened.close());
  assert.equal(reopened.state.version, 5);
  assert.equal((reopened.state as unknown as Record<string, unknown>).root, undefined);
  assert.match(reopened.state.key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.fromEntries(Object.values(reopened.state.members).map(member => [member.id, member.role])), { root: "main", child: "member", other: "member" });
  assert.equal(Object.values(reopened.state.tasks)[0].title, "Keep me");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 5, "the migration is written back");
});

test("v2 tasks gain durable numbers and initial labels without changing existing work", t => {
  const { home, store } = fixture(t);
  const first = store.task("root", { action: "create", title: "Parser tests", description: "Keep all acceptance criteria" }) as Task;
  const second = store.task("child", { action: "create", title: "Review", description: "Existing review", dependencies: [first.id] }) as Task;
  store.task("child", { action: "claim", id: first.id });
  const path = join(store.dir, "state.json");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  legacy.version = 2;
  legacy.tasks[first.id].title = "Run complete parser acceptance checks";
  for (const task of Object.values(legacy.tasks) as Record<string, unknown>[]) { delete task.number; delete task.label; }
  store.close();
  writeFileSync(path, JSON.stringify(legacy));
  const reopened = new Store(initial(), home);
  assert.deepEqual(reopened.state.tasks[first.id], { ...legacy.tasks[first.id], number: 1, label: "Run complete parser" });
  assert.deepEqual(reopened.state.tasks[second.id], { ...legacy.tasks[second.id], number: 2, label: "Review" });
  assert.equal(reopened.state.version, 5);
  const migrated = readFileSync(path, "utf8");
  reopened.close();
  const again = new Store(initial(), home);
  again.close();
  assert.equal(readFileSync(path, "utf8"), migrated, "migration must not renumber tasks on another restart");
  const invalid = JSON.parse(migrated);
  invalid.tasks[second.id].number = 1;
  writeFileSync(path, JSON.stringify(invalid));
  const before = readFileSync(path, "utf8");
  assert.throws(() => new Store(initial(), home), /number/i);
  assert.equal(readFileSync(path, "utf8"), before, "malformed v3 data must not be silently repaired");
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
  assert.throws(() => store.task("child", { action: "complete", id: created.id, revision: edited.revision, acceptance: true, summary: "Done" }), /revision/i);
  assert.throws(() => store.task("child", { action: "complete", id: created.id, acceptance: true, summary: "Done" }), /in-progress/i);
  const started = store.task("child", { action: "start", id: created.id, revision: claimed.revision }) as Task;
  assert.throws(() => store.task("child", { action: "complete", id: created.id, revision: started.revision }), /acceptance/i);
  assert.throws(() => store.task("child", { action: "complete", id: created.id, acceptance: false }), /acceptance/i);
  assert.equal(store.state.tasks[created.id].revision, started.revision);
  const completed = store.task("child", { action: "complete", id: created.id, revision: started.revision, acceptance: true, summary: "Done" }) as Task;
  assert.equal(completed.status, "done");
  assert.equal(completed.revision, started.revision + 1);
});

test("schema 4 posts keep their text as the summary, unchanged", t => {
  const { home, store } = fixture(t);
  const path = join(store.dir, "state.json");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  store.close();
  legacy.version = 4;
  legacy.messages = [{ seq: 1, id: "m1", from: "root", recipients: ["child"], text: "Line one\nline two", time: new Date().toISOString() }];
  writeFileSync(path, JSON.stringify(legacy));
  const reopened = new Store(initial(), home);
  t.after(() => reopened.close());
  assert.equal(reopened.state.version, 5);
  assert.deepEqual([reopened.state.messages[0].summary, "text" in reopened.state.messages[0]], ["Line one\nline two", false]);
});
