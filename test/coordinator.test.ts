import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Coordinator } from "../src/coordinator.ts";
import { Connection } from "../src/connection.ts";

const fixture = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
chmodSync(fixture, 0o755);
async function setup(limit = 10, depth = 2) {
  const home = mkdtempSync(join(tmpdir(), "at-"));
  const notices: number[] = [], warnings: string[] = [];
  const options = { id: randomUUID(), cwd: home, limit, depth, extension: "unused", command: fixture, home, notice: (through: number) => { notices.push(through); }, warning: (message: string) => { warnings.push(message); } };
  const team = await Coordinator.open(options);
  return { team, home, options, notices, warnings, async close() { await team.close(); rmSync(home, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const launch = { action: "launch", model: "test/model", brief: "hello" };
function repository(home: string) {
  const repo = join(home, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "file"), "test"); git("add", "file"); git("commit", "-m", "initial");
  return repo;
}

test("live idle members count; concurrency reserves slots and stop/resume keeps session identity", async () => {
  const f = await setup(1);
  try {
    const results = await Promise.allSettled([f.team.handle("root", "agent", launch), f.team.handle("root", "agent", launch)]);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    assert.match(String((results.find(value => value.status === "rejected") as PromiseRejectedResult).reason), /ceiling/);
    const member = f.team.live()[0];
    await until(() => f.team.store.state.members[member.id].status === "idle");
    await assert.rejects(f.team.handle("root", "agent", launch), /ceiling/);
    const original = f.team.store.state.members[member.id];
    await f.team.handle("root", "agent", { action: "stop", id: member.id });
    assert.equal(f.team.live().length, 0);
    await f.team.handle("root", "agent", { action: "resume", id: member.id, brief: "hello again", model: "test/model" });
    const resumed = f.team.store.state.members[member.id];
    assert.equal(resumed.sessionId, original.sessionId);
    assert.equal(resumed.sessionFile, original.sessionFile);
    assert.notEqual(resumed.token, original.token);
  } finally { await f.close(); }
});

test("real member sockets delegate under one ceiling and subtree stop cascades deepest-first", async () => {
  const f = await setup(3, 2);
  try {
    await f.team.handle("root", "agent", { ...launch, brief: "DELEGATE" });
    await until(() => f.team.live().length === 2 && f.team.live().every(member => member.status === "idle"));
    const parent = f.team.live().find(member => member.parent === "root")!;
    const descendant = f.team.live().find(member => member.parent === parent.id)!;
    assert.equal(descendant.depth, 2);
    await assert.rejects(f.team.handle(descendant.id, "agent", launch), /depth/);
    await assert.rejects(f.team.handle(descendant.id, "agent", { action: "stop", id: parent.id }), /ancestor/);
    await f.team.handle("root", "agent", { action: "stop", id: parent.id });
    assert.equal(f.team.live().length, 0);
    assert.equal(f.team.store.state.members[descendant.id].status, "stopped");
  } finally { await f.close(); }
});

test("child mailbox batching and polling do not consume messages; root is notified once", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", { ...launch, brief: "REPORT:member ready" });
    await until(() => f.notices.length === 1);
    const history = await f.team.handle("root", "message", { action: "history" });
    assert.deepEqual(await f.team.handle("root", "message", { action: "history" }), history);
    assert.equal(f.team.store.state.messages[0].text, "member ready");
    assert.equal(f.team.store.state.members.root.notified, 0);
    f.team.ack("root", f.notices[0]);
    assert.equal(f.team.store.state.members.root.notified, f.notices[0]);
    await assert.rejects(f.team.handle("root", "agent", { action: "limits", limit: 11 }), /explicit/);
    await f.team.handle("root", "agent", { action: "limits", limit: 11 }, true);
    assert.equal(f.team.store.state.limit, 11);
  } finally { await f.close(); }
});

test("forged tokens, extra fields, and unauthenticated connections cannot mutate state", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", launch);
    const member = f.team.live()[0];
    const bad = new Connection(f.team.socketPath, member.id, "forged");
    await bad.open();
    await assert.rejects(bad.request("message", { action: "send", text: "forged" }), /disconnected/);
    bad.close();
    await assert.rejects(f.team.handle("root", "message", { action: "send", text: "test", injected: true }), /Invalid/);
    await assert.rejects(f.team.handle(member.id, "agent", { action: "limits", limit: 1 }), /root/);
    assert.equal(f.team.store.state.messages.length, 0);
    const status = JSON.stringify(await f.team.handle("root", "agent", { action: "list" }));
    assert.equal(status.includes(member.token), false);
  } finally { await f.close(); }
});

test("large valid message and task pages cross the authenticated socket without disconnecting", async () => {
  const f = await setup();
  const reader = { id: "reader", parent: "root", depth: 1, token: randomUUID(), cwd: f.home, status: "idle" as const, notified: 0 };
  f.team.store.update(state => { state.members[reader.id] = reader; });
  const connection = new Connection(f.team.socketPath, reader.id, reader.token);
  try {
    await connection.open();
    await connection.request("join", { sessionId: randomUUID(), sessionFile: join(f.home, "reader.jsonl"), tools: ["team_agent", "team_task", "team_message"], trusted: true });
    const text = "\u0000".repeat(16000);
    for (let index = 0; index < 20; index++) {
      await f.team.handle("root", "message", { action: "send", recipients: ["root"], text });
      await f.team.handle("root", "task", { action: "create", title: `Task ${index}`, description: text });
    }
    const messages = await connection.request("message", { action: "history" }) as { text: string }[];
    assert.equal(messages.length, 20);
    assert.ok(messages.every(message => message.text === text));
    const page = await connection.request("task", { action: "list" }) as { tasks: { id: string; description: string }[]; total: number };
    assert.equal(page.total, 20);
    assert.equal(page.tasks.length, 20);
    assert.ok(page.tasks.every(task => task.description === text));
    assert.ok(await connection.request("task", { action: "read", id: page.tasks[0].id }));
  } finally { connection.close(); await f.close(); }
});

test("provider errors remain visible and notify the requesting ancestor", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", { ...launch, brief: "ERROR" });
    await new Promise(resolve => setTimeout(resolve, 100));
    const member = f.team.live()[0];
    assert.equal(member.status, "idle");
    assert.equal(member.error, "Provider rejected this model");
    assert.match(f.team.store.state.messages.at(-1)!.text, /Provider rejected this model/);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, ["root"]);
  } finally { await f.close(); }
});

test("a provider failure during ancestor death cannot crash shutdown", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", { ...launch, brief: "WAIT" });
    const parent = f.team.live()[0];
    await f.team.handle(parent.id, "agent", { ...launch, brief: "ERROR_ON_ABORT" });
    const child = f.team.live().find(member => member.parent === parent.id)!;
    process.kill(parent.pid!, "SIGKILL");
    await until(() => f.team.live().length === 0);
    assert.equal(f.team.store.state.members[parent.id].status, "interrupted");
    assert.equal(f.team.store.state.members[child.id].status, "stopped");
    assert.equal(f.team.store.state.members[child.id].error, "Provider failed during abort");
    assert.deepEqual(f.warnings, []);
  } finally { await f.close(); }
});

test("skipped project resources reject readiness before any assignment runs", async () => {
  const previous = process.env.AC_TEAMS_TEST_UNTRUSTED;
  process.env.AC_TEAMS_TEST_UNTRUSTED = "1";
  const f = await setup();
  try {
    await assert.rejects(f.team.handle("root", "agent", launch), /skipped protected project resources/);
    assert.equal(f.team.live().length, 0);
  } finally {
    if (previous === undefined) delete process.env.AC_TEAMS_TEST_UNTRUSTED; else process.env.AC_TEAMS_TEST_UNTRUSTED = previous;
    await f.close();
  }
});

test("coordinator shutdown closes owned idle processes and durable recovery keeps stopped history", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", launch);
    const id = f.team.live()[0].id;
    await f.team.close();
    const recovered = await Coordinator.open(f.options);
    try {
      assert.equal(recovered.live().length, 0);
      assert.equal(recovered.store.state.members[id].status, "stopped");
      await recovered.handle("root", "agent", { action: "resume", id, model: "test/model", brief: "resumed after recovery" });
      assert.equal(recovered.live().length, 1);
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

test("stop during asynchronous worktree creation cannot resurrect the launch", async () => {
  const f = await setup();
  try {
    const pending = f.team.handle("root", "agent", { ...launch, cwd: repository(f.home), worktree: true, target: "main" });
    const id = f.team.live()[0].id;
    await f.team.handle("root", "agent", { action: "stop", id });
    await assert.rejects(pending, /stopped/);
    assert.equal(f.team.live().length, 0);
    assert.ok(f.team.store.state.members[id].worktree);
    await f.team.handle("root", "agent", { action: "cleanup", id });
  } finally { await f.close(); }
});

test("cleanup and resume exclude each other for the same stopped member", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", { ...launch, cwd: repository(f.home), worktree: true, target: "main" });
    const member = f.team.live()[0];
    await f.team.handle("root", "agent", { action: "stop", id: member.id });
    const results = await Promise.allSettled([
      f.team.handle("root", "agent", { action: "cleanup", id: member.id }),
      f.team.handle("root", "agent", { action: "resume", id: member.id, model: "test/model", brief: "hello" }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(f.team.live().length, 0);
    assert.equal(existsSync(member.cwd), false);
  } finally { await f.close(); }
});

test("unjoined sockets cannot block coordinator shutdown", { timeout: 3000 }, async () => {
  const f = await setup();
  const socket = connect(f.team.socketPath);
  try { await once(socket, "connect"); await f.team.close(); }
  finally { socket.destroy(); await f.close(); }
});

test("unexpected intermediate process exit stops its descendants", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", { ...launch, brief: "DELEGATE" });
    await until(() => f.team.live().length === 2 && f.team.live().every(member => member.status === "idle"));
    const parent = f.team.live().find(member => member.parent === "root")!;
    const descendant = f.team.live().find(member => member.parent === parent.id)!;
    process.kill(parent.pid!, "SIGKILL");
    await until(() => f.team.live().length === 0);
    assert.equal(f.team.store.state.members[parent.id].status, "interrupted");
    assert.equal(f.team.store.state.members[descendant.id].status, "stopped");
  } finally { await f.close(); }
});
