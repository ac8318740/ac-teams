import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Coordinator, assistantEvent, taskRequestGuidance, type CoordinatorOptions } from "../src/coordinator.ts";
import { Connection } from "../src/connection.ts";

const fixture = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
chmodSync(fixture, 0o755);
async function setup(limit = 10, depth = 2, interactive = false) {
  const home = mkdtempSync(join(tmpdir(), "at-"));
  const notices: number[] = [], warnings: string[] = [];
  const states: { kind: "busy" | "blocked"; active: boolean }[] = [];
  const options: CoordinatorOptions = { status: (kind, active) => { states.push({ kind, active }); }, id: randomUUID(), cwd: home, limit, depth, interactive, extension: "unused", command: fixture, home, notice: (through: number) => { notices.push(through); }, warning: (message: string) => { warnings.push(message); } };
  const team = await Coordinator.open(options);
  return { team, home, options, notices, warnings, states, async close() { await team.close(); rmSync(home, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const launch = { action: "launch", name: "worker", model: "test/model", brief: "hello" };
function repository(home: string) {
  const repo = join(home, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "file"), "test"); git("add", "file"); git("commit", "-m", "initial");
  return repo;
}

for (const interactive of [false, true]) test(`members cannot report directly to Main's Herdr pane (${interactive ? "native" : "RPC"})`, async () => {
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const f = await setup(2, 2, interactive);
  try {
    const member = await f.team.handle("root", "agent", launch) as { pid: number };
    const env = readFileSync(`/proc/${member.pid}/environ`, "utf8").split("\0");
    assert.ok(env.includes("HERDR_ENV=0"));
  } finally { await f.close(); if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
});

test("team attention aggregates busy members and questions, and clears on settle, stop, and exit", async () => {
  const f = await setup();
  try {
    await f.team.handle("root", "agent", { ...launch, brief: "WAIT" });
    await f.team.handle("root", "agent", { ...launch, name: "reviewer", brief: "WAIT" });
    const [one, two] = f.team.live();
    await until(() => f.team.live().every(member => member.activity === "Working"));
    const blocked = (id: string, active: boolean) => f.team.recordEvent(id, { type: "blocked", active });
    const latest = (kind: "busy" | "blocked") => f.states.filter(state => state.kind === kind).at(-1)?.active ?? false;
    assert.equal(latest("busy"), true);
    blocked(one.id, true); blocked(two.id, true);
    assert.equal(latest("blocked"), true);
    assert.equal(f.team.store.state.members[one.id].needsInput, true);
    blocked(one.id, false);
    assert.equal(latest("blocked"), true, "another member still needs an answer");
    f.team.recordEvent(two.id, { type: "agent_settled" });
    assert.equal(latest("blocked"), false, "settling clears an abandoned question");
    assert.equal(latest("busy"), true, "one member is still running");
    blocked(one.id, true);
    await f.team.stopTree(one.id);
    assert.equal(latest("blocked"), false);
    assert.equal(latest("busy"), false);
    assert.equal(f.team.store.state.members[one.id].needsInput, undefined);
    f.team.recordEvent(two.id, { type: "agent_start" });
    blocked(two.id, true);
    process.kill(two.pid!, "SIGKILL");
    await until(() => !f.team.live().length);
    assert.equal(latest("blocked"), false);
    assert.equal(latest("busy"), false);
    blocked("root", true);
    assert.equal(latest("blocked"), false, "Main already owns its local Herdr attention signal");
    assert.equal(f.team.store.state.members.root.needsInput, true);
    assert.throws(() => f.team.recordEvent("root", { type: "blocked", active: "yes" }), /Invalid/);
  } finally { await f.close(); }
});

test("teammates require unique descriptive names; legacy fallbacks remain stable", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: undefined }), /name is required/);
    for (const name of ["three-word-name", "has space", "Uppercase", "a".repeat(41)]) await assert.rejects(f.team.handle("root", "agent", { ...launch, name }), /Invalid/);
    for (const name of ["root", "main"]) await assert.rejects(f.team.handle("root", "agent", { ...launch, name }), /reserved/);
    const member = await f.team.handle("root", "agent", { ...launch, name: "code-review" }) as { id: string; name: string };
    assert.equal(member.name, "code-review");
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "code-review" }), /already in use/);
    await f.team.handle("root", "agent", { action: "stop", id: member.id });
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "code-review" }), /already in use/);
    f.team.store.update(state => { delete state.members[member.id].name; });
    await f.team.close();
    const recovered = await Coordinator.open(f.options);
    try { assert.equal(recovered.store.state.members[member.id].name, "teammate-1"); }
    finally { await recovered.close(); }
    const again = await Coordinator.open(f.options);
    try { assert.equal(again.store.state.members[member.id].name, "teammate-1"); }
    finally { await again.close(); }
  } finally { await f.close(); }
});

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
    assert.equal(resumed.name, original.name);
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
    await f.team.handle(parent.id, "agent", { ...launch, name: "nested-worker", brief: "ERROR_ON_ABORT" });
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

test("new task requests carry critical review instructions without changing existing work", async () => {
  const f = await setup(2, 2, true);
  try {
    await f.team.handle("root", "task", { action: "create", title: "Parser tests", description: "Cover malformed parser inputs and verify errors" });
    const before = structuredClone(f.team.store.state.tasks);
    const text = "Add tests for malformed parser inputs";
    const receipt = await f.team.handle("root", "ui", { action: "task_request", text });
    assert.match(String(receipt), /Sent to Main/);
    const history = await f.team.handle("root", "message", { action: "history" }) as { text: string; recipients: string[] }[];
    assert.deepEqual(history[0].recipients, ["root"]);
    assert.ok(history[0].text.includes(taskRequestGuidance));
    assert.ok(history[0].text.endsWith(`\n\nRequest:\n${text}`), "the user's exact request must remain separate from guidance");
    assert.match(history[0].text, /current task list \(page as needed\)/);
    assert.match(history[0].text, /do not add a duplicate/);
    assert.match(history[0].text, /state and ownership allow it/);
    assert.match(history[0].text, /genuinely distinct, in-scope work/);
    assert.match(history[0].text, /Ask for clarification/);
    assert.match(history[0].text, /Explain the decision/);
    await until(() => f.notices.length === 1);
    assert.deepEqual(f.team.store.state.tasks, before, "submitting a proposal must not create or edit tasks");
  } finally { await f.close(); }
});

test("native members keep PID while idle, stop cleanly, and quietly resume for creator feedback", async () => {
  const f = await setup(2, 2, true);
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string; pid: number; sessionFile: string; sessionId: string; token?: string; terminal: boolean };
    assert.equal(member.terminal, true);
    assert.equal(f.team.store.state.members[member.id].modelName, "Fixture model");
    assert.deepEqual(f.team.store.state.members[member.id].contextUsage, { tokens: 48000, contextWindow: 200000, percent: 24 });
    await f.team.handle(member.id, "event", { type: "telemetry", model: "test/model", modelName: "Fixture model", contextUsage: { tokens: null, contextWindow: 200000, percent: null } });
    assert.equal(f.team.store.state.members[member.id].contextUsage?.tokens, null);
    assert.equal(member.token, undefined);
    await until(() => f.team.store.state.members[member.id].status === "idle");
    const saved = () => JSON.parse(readFileSync(member.sessionFile, "utf8")) as { prompts: string[] };
    assert.deepEqual(saved().prompts, ["hello"]);
    const task = await f.team.handle(member.id, "task", { action: "create", title: "Creator task", description: "Do not mutate from feedback" }) as { id: string; creator: string };
    assert.equal(task.creator, member.id);
    const before = JSON.stringify(f.team.store.state.tasks[task.id]);
    const request = await f.team.handle(member.id, "ui", { action: "task_request", text: "Please create a task" });
    assert.match(String(request), /Sent to Main/);
    assert.equal(f.team.store.state.messages.at(-1)!.text, `User task request (review before changing tasks):\n${taskRequestGuidance}\n\nRequest:\nPlease create a task`);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, ["root"]);
    assert.equal(f.team.store.state.members[member.id].pid, member.pid);
    await f.team.handle("root", "agent", { action: "stop", id: member.id });
    assert.equal(f.team.store.state.members[member.id].status, "stopped");
    const feedback = await f.team.handle("root", "ui", { action: "feedback", id: task.id, text: "Please verify this case" });
    assert.ok(String(feedback).includes(`Sent to ${member.id}`));
    const resumed = f.team.store.state.members[member.id];
    assert.equal(resumed.status, "idle");
    assert.notEqual(resumed.pid, member.pid);
    assert.equal(resumed.sessionId, member.sessionId);
    assert.equal(resumed.sessionFile, member.sessionFile);
    assert.deepEqual(saved().prompts, ["hello"], "UI resume must not replay a made-up assignment");
    assert.equal(JSON.stringify(f.team.store.state.tasks[task.id]), before);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, [member.id]);
    assert.match(f.team.store.state.messages.at(-1)!.text, /User feedback on task/);
    assert.deepEqual(f.warnings, []);
    await f.team.close();
    assert.equal(existsSync(join(f.team.store.dir, "t.sock")), false);
  } finally { await f.close(); }
});

test("idle members retain a bounded completion summary rather than stale tool activity", async () => {
  const f = await setup();
  try {
    assert.equal(assistantEvent({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Not finished" }] }), undefined);
    const summary = assistantEvent({ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Verified parser cases.\nMore detail" }] })!;
    assert.deepEqual(summary, { type: "summary", text: "Verified parser cases." });
    await f.team.handle("root", "event", { type: "agent_start" });
    await f.team.handle("root", "event", { type: "activity", text: "Running tests" });
    await f.team.handle("root", "event", summary);
    await f.team.handle("root", "event", { type: "agent_settled" });
    assert.equal(f.team.store.state.members.root.activity, summary.text);
    assert.equal(assistantEvent({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(1000) }] })!.text.length, 500);
    await f.team.handle("root", "event", { type: "agent_start" });
    assert.equal(f.team.store.state.members.root.summary, undefined);
  } finally { await f.close(); }
});

test("creator resume failure reports Main fallback, while headless roots reject user actions", async () => {
  const f = await setup(1, 2, true);
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    await until(() => f.team.store.state.members[member.id].status === "idle");
    const task = await f.team.handle(member.id, "task", { action: "create", title: "Feedback", description: "Preserve this task" }) as { id: string };
    await f.team.handle("root", "agent", { action: "stop", id: member.id });
    await f.team.handle("root", "agent", { ...launch, name: "busy-worker", brief: "WAIT" });
    const feedback = await f.team.handle("root", "ui", { action: "feedback", id: task.id, text: "Review this" });
    assert.match(String(feedback), /could not resume.*delivered to Main instead/);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, ["root"]);
    await assert.rejects(f.team.handle("root", "event", { type: "bad_event" }), /Invalid/);
  } finally { await f.close(); }
  const headless = await setup();
  try { await assert.rejects(headless.team.handle("root", "ui", { action: "task_request", text: "Hello" }), /interactive root/); }
  finally { await headless.close(); }
});

test("full-size user text survives task envelopes, transport and recovery; stopping creators fall back", async () => {
  const f = await setup(2, 2, true);
  const member = { id: "creator", parent: "root", depth: 1, token: randomUUID(), cwd: f.home, status: "idle" as const, notified: 0 };
  f.team.store.update(state => { state.members[member.id] = member; });
  const reader = new Connection(f.team.socketPath, member.id, member.token);
  try {
    await reader.open();
    await reader.request("join", { sessionId: randomUUID(), sessionFile: join(f.home, "creator.jsonl"), tools: ["team_agent", "team_task", "team_message"], trusted: true });
    const text = "q".repeat(16000);
    const task = await f.team.handle(member.id, "task", { action: "create", title: "t".repeat(500), label: "Boundary task", description: "Boundary task" }) as { id: string };
    await f.team.handle("root", "ui", { action: "task_request", text });
    await f.team.handle("root", "ui", { action: "feedback", id: task.id, text });
    await assert.rejects(f.team.handle("root", "message", { action: "send", text: text + "q" }), /Invalid/);
    const history = await reader.request("message", { action: "history" }) as { text: string }[];
    assert.equal(history.length, 2);
    assert.ok(history.every(message => message.text.endsWith(text)));
    f.team.store.update(state => { state.members[member.id].status = "stopping"; });
    const result = await f.team.handle("root", "ui", { action: "feedback", id: task.id, text: "Feedback during shutdown" });
    assert.match(String(result), /stopping.*delivered to Main instead/);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, ["root"]);
    await assert.rejects(f.team.handle("root", "ui", { action: "resume", id: member.id }), /stopping/);
    reader.close();
    await f.team.close();
    const recovered = await Coordinator.open(f.options);
    try { assert.equal(recovered.store.state.messages.length, 3); assert.ok(recovered.store.state.messages[1].text.endsWith(text)); }
    finally { await recovered.close(); }
  } finally { reader.close(); await f.close(); }
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
