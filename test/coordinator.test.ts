import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mainEnv, handoverPrompt } from "../src/members/main-terminal.ts";
import { RpcAgent } from "../src/members/rpc-agent.ts";
import { TerminalAgent } from "../src/members/terminal-agent.ts";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Coordinator, assistantEvent, taskRequestGuidance, type CoordinatorOptions } from "../src/team/coordinator.ts";
import { Connection } from "../src/team/connection.ts";
import { TeamProtocol } from "../src/team/protocol.ts";
import { saveWorkerConfiguration } from "../src/settings/config.ts";
import { extensionInventory } from "../src/settings/worker-extensions.ts";
import { mkdirSync } from "node:fs";

const fixture = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
chmodSync(fixture, 0o755);
async function setup(limit = 10, depth = 2, interactive = false) {
  const home = mkdtempSync(join(tmpdir(), "at-"));
  const notices: number[] = [], warnings: string[] = [];
  const states: { kind: "busy" | "blocked"; active: boolean }[] = [];
  const options: CoordinatorOptions = { extensions: () => extensionInventory(home), resources: () => ({ scope: "host", memory: { totalBytes: 10000, availableBytes: 5000, swapUsedBytes: 0 }, memoryPressure: { someAvg10: 0, fullAvg10: 0, fullAvg60: 0 }, warnings: [] }), status: (kind, active) => { states.push({ kind, active }); }, id: randomUUID(), cwd: home, limit, depth, interactive, extension: "unused", command: fixture, home, notice: (through: number) => { notices.push(through); }, warning: (message: string) => { warnings.push(message); } };
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

for (const interactive of [false, true]) test(`extension presets select before spawn, preserve resume IDs, and forward heap/config (${interactive ? "native" : "RPC"})`, async () => {
  const f = await setup();
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "NODE_OPTIONS", "BILLION_CONTEXT_ATTACH"];
  const previous = keys.map(key => process.env[key]);
  process.env.HOME = f.home;
  process.env.PI_CODING_AGENT_DIR = join(f.home, "agent");
  process.env.NODE_OPTIONS = "--max-old-space-size=6144 --no-warnings";
  process.env.BILLION_CONTEXT_ATTACH = "http://127.0.0.1:19999";
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
  const guard = join(process.env.PI_CODING_AGENT_DIR, "extensions", "guard.ts");
  writeFileSync(guard, "throw new Error('fixture must not import');\n");
  f.options.interactive = interactive;
  try {
    const inventory = await extensionInventory(f.home);
    const id = inventory.entries.find(entry => entry.path === guard)!.id;
    saveWorkerConfiguration(f.home, "user", { defaultPreset: "worker", required: [id], presets: { worker: { extensions: [], heapMb: 1536 }, full: { extensions: "all" } } });
    const member = await f.team.handle("root", "agent", launch) as { id: string; pid: number; extensions: { ids: string[]; heapMb: number } };
    assert.deepEqual(member.extensions.ids, [id]);
    const args = readFileSync(`/proc/${member.pid}/cmdline`, "utf8").split("\0");
    assert.ok(args.includes("-ne"));
    assert.ok(args.includes(guard));
    const env = readFileSync(`/proc/${member.pid}/environ`, "utf8").split("\0");
    assert.ok(env.includes("NODE_OPTIONS=--no-warnings --max-old-space-size=1536"));
    assert.ok(env.includes(`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`));
    assert.ok(env.includes("BILLION_CONTEXT_ATTACH=http://127.0.0.1:19999"));
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "unsafe", extensions: { exclude: [id] } }), /required/i);
    await f.team.stopTree(member.id);
    saveWorkerConfiguration(f.home, "user", { defaultPreset: "full", required: [id], presets: { full: { extensions: "all" } } });
    const resumed = await f.team.handle("root", "agent", { action: "resume", id: member.id, brief: "continue", model: "test/model" }) as typeof member;
    assert.deepEqual(resumed.extensions.ids, [id]);
    assert.equal(resumed.extensions.heapMb, 1536);
    await f.team.stopTree(member.id);
  } finally { await f.close(); keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});

test("full and include never widen a nested worker's actual parent set, even in another cwd", async () => {
  const f = await setup();
  const home = process.env.HOME, agent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = f.home; process.env.PI_CODING_AGENT_DIR = join(f.home, "agent");
  const extensions = join(process.env.PI_CODING_AGENT_DIR, "extensions"); mkdirSync(extensions, { recursive: true });
  const a = join(extensions, "a.ts"), b = join(extensions, "b.ts");
  writeFileSync(a, "export default ()=>{};"); writeFileSync(b, "export default ()=>{};");
  f.options.extensions = () => extensionInventory(f.home, process.env.PI_CODING_AGENT_DIR, [a, b]);
  try {
    const inventory = await f.options.extensions();
    const aid = inventory.entries.find(entry => entry.path === a)!.id, bid = inventory.entries.find(entry => entry.path === b)!.id;
    saveWorkerConfiguration(f.home, "user", { defaultPreset: "full", required: [aid], presets: { full: { extensions: "all" } } });
    const parent = await f.team.handle("root", "agent", { ...launch, extensions: { exclude: [bid] } }) as { id: string };
    const cwd = join(f.home, "other"); mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true }); writeFileSync(join(cwd, ".pi", "extensions", "extra.ts"), "throw new Error('do not import');");
    const child = await f.team.handle(parent.id, "agent", { ...launch, name: "nested", cwd, extensions: { preset: "full" } }) as { id: string; extensions: { ids: string[] } };
    assert.deepEqual(child.extensions.ids, [aid]);
    await f.team.stopTree(child.id);
    await assert.rejects(f.team.handle(parent.id, "agent", { ...launch, name: "wider", extensions: { preset: "full", include: [bid] } }), /unavailable or disabled/);
    await f.team.stopTree(parent.id);
  } finally {
    await f.close();
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agent;
  }
});

test("unknown actual parent loading fails closed rather than discovering installed extensions", async () => {
  const f = await setup(); delete f.options.extensions;
  try { await assert.rejects(f.team.handle("root", "agent", launch), /Actual parent extensions are unavailable/); }
  finally { await f.close(); }
});

for (const interactive of [false, true]) test(`members cannot report directly to Main's Herdr pane (${interactive ? "native" : "RPC"})`, async () => {
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const f = await setup(2, 2, interactive);
  try {
    const member = await f.team.handle("root", "agent", launch) as { pid: number };
    const env = readFileSync(`/proc/${member.pid}/environ`, "utf8").split("\0");
    assert.ok(env.includes("HERDR_ENV=0"));
    assert.ok(env.includes("ACSTACK_AGENT_ROLE=member"), "ACStack hooks see a member, not a main session");
  } finally { await f.close(); if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; }
});

for (const interactive of [false, true]) test(`analysis launch policy preserves settings and resume preferences (${interactive ? "native" : "RPC"})`, async () => {
  const previous = process.env.PI_LENS_WARM_ATTACH;
  const f = await setup(2, 2, interactive);
  try {
    const settings = ["PI_LENS_HOME", "PILENS_DATA_DIR", "PI_LENS_CONFIG_PATH", "PATH"].map(key => [key, process.env[key]]);
    const cases = [
      { inherited: undefined, analysis: undefined, expected: "1", reason: "reuse requested" },
      { inherited: "", analysis: "auto", expected: "1", reason: "reuse requested" },
      { inherited: "1", analysis: "auto", expected: "1", reason: "reuse requested" },
      { inherited: "0", analysis: "auto", expected: "0", reason: "separate: explicit opt-out" },
      { inherited: "custom", analysis: "auto", expected: "custom", reason: "inherited setting unchanged" },
      { inherited: "1", analysis: "separate", expected: "0", reason: "separate requested" },
    ];
    for (const [i, c] of cases.entries()) {
      if (c.inherited === undefined) delete process.env.PI_LENS_WARM_ATTACH; else process.env.PI_LENS_WARM_ATTACH = c.inherited;
      const member = await f.team.handle("root", "agent", { ...launch, name: `worker-${i}`, analysis: c.analysis }) as { id: string; pid: number; analysis: string; analysisPolicy: { warmAttach: string; reason: string } };
      const env = readFileSync(`/proc/${member.pid}/environ`, "utf8").split("\0");
      assert.ok(env.includes(`PI_LENS_WARM_ATTACH=${c.expected}`));
      for (const [key, value] of settings) assert.equal(env.find(entry => entry.startsWith(`${key}=`)), value === undefined ? undefined : `${key}=${value}`);
      assert.equal(process.env.PI_LENS_WARM_ATTACH, c.inherited, "launch must not change the parent environment");
      assert.equal(member.analysis, c.analysis ?? "auto");
      assert.deepEqual(member.analysisPolicy, { warmAttach: c.expected, reason: c.reason });
      // Status describes this launch, not a later change in the coordinator environment.
      process.env.PI_LENS_WARM_ATTACH = "changed-after-launch";
      const status = await f.team.handle("root", "agent", { action: "status", id: member.id }) as typeof member;
      assert.deepEqual(status.analysisPolicy, member.analysisPolicy);
      const list = await f.team.handle("root", "agent", { action: "list" }) as { members: typeof member[] };
      assert.deepEqual(list.members.find(entry => entry.id === member.id)?.analysisPolicy, member.analysisPolicy);
      assert.equal(Object.hasOwn(status.analysisPolicy, "shared"), false);
      const saved = JSON.parse(readFileSync(join(f.team.store.dir, "state.json"), "utf8")).members[member.id];
      assert.equal(saved.analysis, c.analysis ?? "auto");
      assert.equal(Object.hasOwn(saved, "analysisPolicy"), false, "only requested preferences are persisted");
      await f.team.stopTree(member.id);
      if (c.analysis === "separate") {
        process.env.PI_LENS_WARM_ATTACH = "1";
        const resume = { action: "resume", id: member.id, brief: "continue", model: "test/model" };
        const retained = await f.team.handle("root", "agent", resume) as typeof member;
        assert.equal(retained.analysis, "separate");
        assert.ok(readFileSync(`/proc/${retained.pid}/environ`, "utf8").split("\0").includes("PI_LENS_WARM_ATTACH=0"));
        await f.team.stopTree(member.id);
        const overridden = await f.team.handle("root", "agent", { ...resume, analysis: "auto" }) as typeof member;
        assert.equal(overridden.analysis, "auto");
        assert.ok(readFileSync(`/proc/${overridden.pid}/environ`, "utf8").split("\0").includes("PI_LENS_WARM_ATTACH=1"));
        await f.team.stopTree(member.id);
      }
    }
    for (const analysis of ["shared", false, 1, null]) await assert.rejects(f.team.handle("root", "agent", { ...launch, analysis }), /Invalid agent request/);
    for (const action of ["list", "status", "stop", "limits", "cleanup"]) await assert.rejects(f.team.handle("root", "agent", { action, analysis: "auto" }), /Analysis can only be set on launch or resume/);
  } finally { await f.close(); if (previous === undefined) delete process.env.PI_LENS_WARM_ATTACH; else process.env.PI_LENS_WARM_ATTACH = previous; }
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

test("an explicit team pause survives notification turns, but final replies and cancellation yield to the user", async () => {
  const f = await setup();
  const busy = () => f.states.filter(state => state.kind === "busy").at(-1)?.active ?? false;
  try {
    const task = await f.team.handle("root", "task", { action: "create", title: "Observe" }) as { id: string };
    await f.team.handle("root", "message", { action: "watch", tasks: [task.id] });
    assert.equal(busy(), false, "watch registration alone is not a pause");
    await f.team.handle("root", "message", { action: "wait" });
    assert.equal(busy(), true);
    f.team.recordEvent("root", { type: "agent_settled" });
    assert.equal(f.team.store.state.members.root.status, "idle");
    f.team.recordEvent("root", { type: "agent_start" });
    f.team.recordEvent("root", { type: "agent_settled" });
    assert.equal(busy(), true, "an unrelated notification-only turn must not flash done");
    f.team.recordEvent("root", { type: "summary", text: "Should I continue?" });
    assert.equal(busy(), false, "ordinary final replies hand control to the user without parsing words");
    await f.team.handle("root", "message", { action: "wait" });
    f.team.recordEvent("root", { type: "cancelled" });
    assert.equal(busy(), false);
  } finally { await f.close(); }
});

test("attention snapshots follow each parent's subtree, including grandchildren and joined mains", async () => {
  const f = await setup();
  let connection: Connection | undefined;
  const rootBusy = () => f.states.filter(state => state.kind === "busy").at(-1)?.active ?? false;
  const snapshots: { busy: boolean; blocked: boolean }[] = [];
  try {
    const added = await addMain(f.team, f.home);
    const main = f.team.store.state.members[added.id];
    connection = new Connection(f.team.socketPath, main.id, main.token);
    connection.on("attention", value => snapshots.push(value));
    await connection.open();
    await connection.request("join", { sessionId: main.sessionId, sessionFile: main.sessionFile, tools: ["team_agent", "team_task", "team_message"], trusted: true, extensionPaths: [] });
    const child = await f.team.handle(main.id, "agent", { ...launch, brief: "WAIT" }) as { id: string };
    await until(() => snapshots.at(-1)?.busy === true);
    assert.equal(rootBusy(), false, "another main's child must not light up the coordinator owner's pane");
    const grandchild = await f.team.handle(child.id, "agent", { ...launch, name: "grandchild", brief: "WAIT" }) as { id: string };
    f.team.recordEvent(child.id, { type: "agent_settled" });
    await until(() => f.team.store.state.members[grandchild.id].activity === "Working");
    assert.equal(snapshots.at(-1)?.busy, true);
    assert.equal(f.team.store.state.members[main.id].status, "idle", "pane attention does not rewrite individual status");
    f.team.recordEvent(grandchild.id, { type: "blocked", active: true });
    await until(() => snapshots.at(-1)?.blocked === true);
    f.team.recordEvent(main.id, { type: "summary", text: "Please check the proposed API." });
    await until(() => snapshots.at(-1)?.busy === false);
    assert.equal(snapshots.at(-1)?.blocked, true, "question-tool attention still takes precedence");
    f.team.recordEvent(grandchild.id, { type: "blocked", active: false });
    f.team.recordEvent(main.id, { type: "agent_start" });
    await until(() => snapshots.at(-1)?.busy === true);
    await f.team.stopTree(child.id);
    await until(() => snapshots.at(-1)?.busy === false);
  } finally { connection?.close(); await f.close(); }
});

test("unchanged events and notification cursors do not rewrite state; real changes remain durable", async () => {
  const f = await setup();
  const path = join(f.team.store.dir, "state.json");
  try {
    for (const event of [
      { type: "activity", text: "Running read" },
      { type: "telemetry", model: "test/model", modelName: "Test", contextUsage: { tokens: 1000, contextWindow: 100000, percent: 1 } },
      { type: "blocked", active: true }, { type: "blocked", active: false },
      { type: "summary", text: "Done" }, { type: "agent_start" }, { type: "agent_settled" },
    ]) {
      f.team.recordEvent("root", event);
      const state = f.team.store.state;
      const inode = statSync(path).ino;
      f.team.recordEvent("root", structuredClone(event));
      assert.equal(f.team.store.state, state, event.type);
      assert.equal(statSync(path).ino, inode, event.type);
    }
    const previous = f.team.store.state;
    f.team.recordEvent("root", { type: "activity", text: "Running edit" });
    assert.notEqual(f.team.store.state.members.root.contextUsage, previous.members.root.contextUsage, "real updates keep snapshots isolated");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).members.root.activity, "Running edit");
    await f.team.handle("root", "message", { action: "send", recipients: ["root"], summary: "Keep this history" });
    f.team.ack("root", 1);
    const state = f.team.store.state;
    f.team.ack("root", 1); f.team.ack("root", 0);
    assert.equal(f.team.store.state, state);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).members.root.notified, 1);
    assert.throws(() => f.team.ack("root", -1), /Invalid/);
    assert.throws(() => f.team.ack("root", 2), /Invalid/);
    assert.throws(() => f.team.recordEvent("root", { type: "blocked", active: "yes" }), /Invalid/);
  } finally { await f.close(); }
});

test("repeated identical member errors still deliver separate durable parent messages", async () => {
  const f = await setup();
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    await until(() => f.team.store.state.members[member.id].status === "idle");
    const before = f.team.store.state.messages.length;
    for (let i = 0; i < 2; i++) f.team.recordEvent(member.id, { type: "model_error", text: "Temporary failure" });
    assert.equal(f.team.store.state.messages.length, before + 2);
    assert.equal(JSON.parse(readFileSync(join(f.team.store.dir, "state.json"), "utf8")).messages.length, before + 2);
    await until(() => f.notices.includes(f.team.store.state.messages.at(-1)!.seq));
  } finally { await f.close(); }
});

test("task watches survive unrelated turns and restart, then clear only on matching delivery acknowledgement", async () => {
  const f = await setup();
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    const task = await f.team.handle(member.id, "task", { action: "create", title: "Work" }) as { id: string };
    await f.team.handle("root", "message", { action: "watch", tasks: [task.id] });
    await f.team.handle(member.id, "message", { action: "send", recipients: ["root"], summary: "Unrelated question" });
    const unrelated = f.team.store.state.messages.at(-1)!;
    await f.team.handle("root", "event", { type: "agent_start" });
    f.team.ack("root", unrelated.seq);
    assert.equal(f.team.store.state.members.root.watches?.length, 1);
    await f.team.handle(member.id, "task", { action: "start", id: task.id });
    await f.team.handle(member.id, "task", { action: "complete", id: task.id, acceptance: true, summary: "Verified" });
    const outcome = f.team.store.state.messages.at(-1)!;
    assert.deepEqual(outcome.recipients, ["root"], "routing and subscription do not duplicate a recipient");
    assert.equal(f.team.store.state.members.root.watches?.[0].seq, outcome.seq);
    await f.team.close();
    const reopened = await Coordinator.open(f.options);
    try {
      assert.equal(reopened.store.state.members.root.watches?.[0].seq, outcome.seq);
      reopened.ack("root", unrelated.seq);
      assert.equal(reopened.store.state.members.root.watches?.length, 1, "older acknowledgements cannot consume the trigger");
      reopened.ack("root", outcome.seq);
      assert.deepEqual(reopened.store.state.members.root.watches, []);
    } finally { await reopened.close(); }
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
    f.team.store.update(state => { delete state.members[member.id].analysis; });
    await f.team.handle("root", "agent", { action: "resume", id: member.id, brief: "hello again", model: "test/model" });
    const resumed = f.team.store.state.members[member.id];
    assert.equal(resumed.analysis, "auto", "older member records default to auto on resume");
    assert.equal(resumed.name, original.name);
    assert.equal(resumed.sessionId, original.sessionId);
    assert.equal(resumed.sessionFile, original.sessionFile);
    assert.notEqual(resumed.token, original.token);
  } finally { await f.close(); }
});

test("resource advisories reach launch, resume, list, and limits without changing ceilings or sessions", async () => {
  const f = await setup(2);
  try {
    let reads = 0;
    f.options.resources = () => { reads++; return { scope: "host", memory: null, memoryPressure: null, warnings: ["Headroom unavailable; sequence work"] }; };
    const first = await f.team.handle("root", "agent", launch) as { id: string; resources: { warnings: string[]; liveMembers: number; startingMembers: number } };
    assert.equal(reads, 1, "launch samples once before startup, not on every event");
    assert.deepEqual(first.resources.warnings, ["Headroom unavailable; sequence work"]);
    assert.equal(first.resources.liveMembers, 0);
    assert.equal(f.warnings[0], "Headroom unavailable; sequence work");
    for (const action of ["list", "limits"]) {
      const result = await f.team.handle("root", "agent", { action }) as { limit: number; resources: typeof first.resources };
      assert.equal(result.limit, 2, "advisory does not silently change policy");
      assert.equal(result.resources.liveMembers, 1);
      assert.match(result.resources.warnings[0], /unavailable/);
    }
    const original = f.team.store.state.members[first.id];
    await f.team.handle("root", "agent", { action: "stop", id: first.id });
    const resumed = await f.team.handle("root", "agent", { action: "resume", id: first.id, model: "test/model", brief: "again" }) as { sessionFile: string; resources: typeof first.resources };
    assert.equal(resumed.sessionFile, original.sessionFile);
    assert.equal(resumed.resources.liveMembers, 0);
    assert.match(resumed.resources.warnings[0], /unavailable/);
    assert.equal(reads, 4);
    assert.equal("resources" in f.team.store.state.members[first.id], false, "do not persist stale headroom in history");
  } finally { await f.close(); }
});

test("concurrent launch advisories include starting reservations before their processes consume memory", async () => {
  const f = await setup(2);
  try {
    const results = await Promise.all([
      f.team.handle("root", "agent", launch),
      f.team.handle("root", "agent", { ...launch, name: "reviewer" }),
    ]) as { resources: { liveMembers: number; startingMembers: number; warnings: string[] } }[];
    assert.equal(results[0].resources.startingMembers, 0);
    assert.equal(results[1].resources.liveMembers, 1);
    assert.equal(results[1].resources.startingMembers, 1);
    assert.match(results[1].resources.warnings.join(" "), /starting.*memory cost/);
    assert.doesNotMatch(results[1].resources.warnings.join(" "), /sequence|sequential/i);
    assert.equal(f.team.live().length, 2, "resource guidance is advisory, unlike the explicit ceiling");
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
    assert.equal(f.team.store.state.messages[0].summary, "member ready");
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
    await assert.rejects(bad.request("message", { action: "send", summary: "forged" }), /disconnected/);
    bad.close();
    await assert.rejects(f.team.handle("root", "message", { action: "send", summary: "test", injected: true }), /Invalid/);
    await assert.rejects(f.team.handle(member.id, "agent", { action: "limits", limit: 1 }), /main session/);
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
    await connection.request("join", { sessionId: randomUUID(), sessionFile: join(f.team.store.dir, "sessions", "ac-teams", f.team.store.state.id, "reader", "reader.jsonl"), tools: ["team_agent", "team_task", "team_message"], trusted: true });
    const text = "\u0000".repeat(16000);
    for (let index = 0; index < 20; index++) {
      await f.team.handle("root", "message", { action: "send", recipients: ["root"], summary: text });
      await f.team.handle("root", "task", { action: "create", title: `Task ${index}`, description: text });
    }
    const messages = await connection.request("message", { action: "history" }) as { summary: string }[];
    assert.equal(messages.length, 20);
    assert.ok(messages.every(message => message.summary === text));
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
    assert.match(f.team.store.state.messages.at(-1)!.summary, /Provider rejected this model/);
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
    assert.deepEqual(f.warnings, ["Worker extension presets are not configured. Workers retain the actual parent extension set; run /teams config to configure lean workers."]);
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
    await until(() => f.team.store.state.members[id].status === "idle");
    await f.team.close();
    assert.equal(f.team.store.state.members[id].handover, "idle");
    const recovered = await Coordinator.open(f.options);
    try {
      // The next owner's resume pass restores the idle member without a new prompt.
      await until(() => recovered.store.state.members[id].status === "idle");
      assert.equal(recovered.store.state.members[id].handover, undefined);
      await recovered.handle("root", "agent", { action: "stop", id });
      assert.equal(recovered.live().length, 0);
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
    const history = await f.team.handle("root", "message", { action: "history" }) as { summary: string; recipients: string[] }[];
    assert.deepEqual(history[0].recipients, ["root"]);
    assert.ok(history[0].summary.includes(taskRequestGuidance));
    assert.ok(history[0].summary.endsWith(`\n\nRequest:\n${text}`), "the user's exact request must remain separate from guidance");
    assert.match(history[0].summary, /current task list \(page as needed\)/);
    assert.match(history[0].summary, /do not add a duplicate/);
    assert.match(history[0].summary, /state and ownership allow it/);
    assert.match(history[0].summary, /genuinely distinct, in-scope work/);
    assert.match(history[0].summary, /Ask for clarification/);
    assert.match(history[0].summary, /Explain the decision/);
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
    const saved = () => ({ prompts: readFileSync(member.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message").map(entry => entry.message.content[0].text as string) });
    const launchPrompt = saved().prompts[0];
    assert.ok(launchPrompt.startsWith("hello\n\n"));
    assert.match(launchPrompt, /recipient ID: root/);
    assert.match(launchPrompt, /task-linked posts already reach/);
    assert.equal(saved().prompts.length, 1);
    const task = await f.team.handle(member.id, "task", { action: "create", title: "Creator task", description: "Do not mutate from feedback" }) as { id: string; creator: string };
    assert.equal(task.creator, member.id);
    const before = JSON.stringify(f.team.store.state.tasks[task.id]);
    const request = await f.team.handle(member.id, "ui", { action: "task_request", text: "Please create a task" });
    assert.match(String(request), /Sent to Main/);
    assert.equal(f.team.store.state.messages.at(-1)!.summary, `User task request (review before changing tasks):\n${taskRequestGuidance}\n\nRequest:\nPlease create a task`);
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
    assert.deepEqual(saved().prompts, [launchPrompt], "UI resume must not replay a made-up assignment");
    assert.equal(JSON.stringify(f.team.store.state.tasks[task.id]), before);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, [member.id]);
    assert.match(f.team.store.state.messages.at(-1)!.summary, /User feedback on task/);
    assert.deepEqual(f.warnings, ["Worker extension presets are not configured. Workers retain the actual parent extension set; run /teams config to configure lean workers."]);
    await f.team.close();
    assert.equal(existsSync(join(f.team.store.dir, "t.sock")), false);
  } finally { await f.close(); }
});

test("Pi abort errors are cancellation, not model failures that wake the lead during reload", async () => {
  const f = await setup();
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    await until(() => f.team.store.state.members[member.id].status === "idle");
    for (const stopReason of ["aborted", "error"]) {
      const event = assistantEvent({ role: "assistant", stopReason, errorMessage: "This operation was aborted", content: [] })!;
      assert.deepEqual(event, { type: "cancelled", text: "" });
      await f.team.handle(member.id, "event", event);
      assert.equal(f.team.store.state.messages.length, 0, "a deliberate pause must not trigger a new lead turn");
      assert.equal(f.team.store.state.members[member.id].error, undefined);
    }
    const failure = assistantEvent({ role: "assistant", stopReason: "error", errorMessage: "503 Service unavailable", content: [] })!;
    assert.deepEqual(failure, { type: "model_error", text: "503 Service unavailable" });
    await f.team.handle(member.id, "event", failure);
    assert.equal(f.team.store.state.messages.length, 1, "genuine failures still notify the lead");
    assert.match(f.team.store.state.messages[0].summary, /model error: 503 Service unavailable/);
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
  const member = { id: "creator", role: "member" as const, parent: "root", depth: 1, token: randomUUID(), cwd: f.home, status: "idle" as const, notified: 0 };
  f.team.store.update(state => { state.members[member.id] = member; });
  const reader = new Connection(f.team.socketPath, member.id, member.token);
  try {
    await reader.open();
    await reader.request("join", { sessionId: randomUUID(), sessionFile: join(f.team.store.dir, "sessions", "ac-teams", f.team.store.state.id, "creator", "creator.jsonl"), tools: ["team_agent", "team_task", "team_message"], trusted: true });
    const text = "q".repeat(16000);
    const task = await f.team.handle(member.id, "task", { action: "create", title: "t".repeat(500), label: "Boundary task", description: "Boundary task" }) as { id: string };
    await f.team.handle("root", "ui", { action: "task_request", text });
    await f.team.handle("root", "ui", { action: "feedback", id: task.id, text });
    await assert.rejects(f.team.handle("root", "message", { action: "send", recipients: ["root"], summary: text + "q" }), /Invalid/);
    const history = await reader.request("message", { action: "history" }) as { summary: string }[];
    assert.equal(history.length, 2);
    assert.ok(history.every(message => message.summary.endsWith(text)));
    f.team.store.update(state => { state.members[member.id].status = "stopping"; });
    const result = await f.team.handle("root", "ui", { action: "feedback", id: task.id, text: "Feedback during shutdown" });
    assert.match(String(result), /stopping.*delivered to Main instead/);
    assert.deepEqual(f.team.store.state.messages.at(-1)!.recipients, ["root"]);
    await assert.rejects(f.team.handle("root", "ui", { action: "resume", id: member.id }), /stopping/);
    reader.close();
    await f.team.close();
    const recovered = await Coordinator.open(f.options);
    try { assert.equal(recovered.store.state.messages.length, 3); assert.ok(recovered.store.state.messages[1].summary.endsWith(text)); }
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

test("enforced access fails closed, cannot be escalated by a sandboxed member, and blocks privileged user actions", async () => {
  const f = await setup(4, 3);
  try {
    // No credential broker means enforced access is unavailable, whatever the host supports.
    assert.equal((await f.team.handle("root", "agent", { action: "list" }) as { sandbox: { available: boolean } }).sandbox.available, false);
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "reader", access: { read: ["."] } }), /Enforced access is unavailable/);
    assert.equal(Object.values(f.team.store.state.members).some(member => member.name === "reader"), false);
    await assert.rejects(f.team.handle("root", "agent", { action: "resume", id: "x", brief: "b", model: "test/model", access: { read: ["."] } }), /Invalid agent request|only be set on launch/);
    const worker = await f.team.handle("root", "agent", launch) as { id: string };
    f.team.store.update(state => { state.members[worker.id].access = { read: [f.home], write: [], network: {} }; });
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "writer", access: { write: ["."] } }), /Write access .* exceeds/);
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "wide", access: { read: ["/"] } }), /would expose/);
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "plain", cwd: "/" }), /cwd must be inside/);
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "inherit" }), /Enforced access is unavailable/);
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "tree", worktree: true }), /Worktrees cannot be combined/);
    await assert.rejects(f.team.handle(worker.id, "ui", { action: "resume", id: worker.id }), /Sandboxed members cannot send user team actions/);
    const env = readFileSync(`/proc/${f.team.store.state.members[worker.id].pid}/environ`, "utf8").split("\0");
    assert.ok(env.includes('AC_TEAMS_ACCESS={"enforced":false}'));
  } finally { await f.close(); }
});

test("a member cannot claim a session file outside its assigned directory", async () => {
  const f = await setup();
  process.env.AC_TEAMS_TEST_SESSION_FILE = join(f.home, "elsewhere", "forged.jsonl");
  try {
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "forger" }), /outside its assigned directory/);
  } finally { delete process.env.AC_TEAMS_TEST_SESSION_FILE; await f.close(); }
});

test("network access is inherited when omitted and can only narrow", async () => {
  const f = await setup(4, 3);
  try {
    const worker = await f.team.handle("root", "agent", launch) as { id: string };
    f.team.store.update(state => { state.members[worker.id].access = { read: [f.home], write: [], network: { allow: ["docs.example.com"] } }; });
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "public", access: { read: ["."], network: {} } }), /restricted network access cannot launch one with public access/);
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "wider", access: { read: ["."], network: { allow: ["*.example.com"] } } }), /exceeds/);
    // Omitted network keeps the requester's restriction, then fails only because Docker access is unavailable in this test.
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "inherit", access: { read: ["."] } }), /Enforced access is unavailable/);
    await assert.rejects(f.team.handle(worker.id, "agent", { ...launch, name: "narrow", access: { read: ["."], network: { allow: [] } } }), /Enforced access is unavailable/);
  } finally { await f.close(); }
});

// Session roles: main sessions, promotion, joining, leaving, and coordinator handover.
/** Connects a main session as a coordinator client, answering shutdown commands like a real session. */
async function mainClient(team: Coordinator, id: string) {
  const member = team.store.state.members[id];
  const link = new Connection(team.socketPath, id, member.token);
  link.on("command", (command: { id: string; command: string }) => {
    void link.request("control_result", { id: command.id, data: {} }).then(() => { if (command.command === "shutdown") link.close(); }, () => {});
  });
  await link.open();
  await link.request("join", { sessionId: member.sessionId, sessionFile: member.sessionFile, tools: ["team_agent", "team_task", "team_message"], trusted: true, extensionPaths: [] });
  return link;
}
async function addMain(team: Coordinator, home: string) {
  const sessionId = randomUUID(), sessionFile = join(home, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: home }) + "\n");
  const probe = new Connection(team.socketPath, "join", team.store.state.key);
  await probe.open();
  try { return { ...await probe.request("add_main", { sessionId, sessionFile, cwd: home }) as { id: string; token: string }, sessionId, sessionFile }; }
  finally { probe.close(); }
}
test("joined mains cannot reuse a stale loaded ceiling after missing or malformed reconnect metadata", async () => {
  const f = await setup();
  let link: Connection | undefined;
  try {
    const main = await addMain(f.team, f.home);
    link = await mainClient(f.team, main.id);
    let attempt = 0;
    for (const extensionPaths of [undefined, "not-an-array"]) {
      attempt++;
      await link.request("join", { sessionId: main.sessionId, sessionFile: main.sessionFile, tools: ["team_agent", "team_task", "team_message"], trusted: true, extensionPaths: [] });
      const first = await f.team.handle(main.id, "agent", { ...launch, name: `before-${attempt}` }) as { id: string };
      await f.team.stopTree(first.id);
      await link.request("join", { sessionId: main.sessionId, sessionFile: main.sessionFile, tools: ["team_agent", "team_task", "team_message"], trusted: true, extensionPaths });
      await assert.rejects(f.team.handle(main.id, "agent", { ...launch, name: `after-${attempt}` }), /Actual parent extensions are unavailable/);
    }
  } finally { link?.close(); await f.close(); }
});

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

test("a main session's environment drops member identity and Herdr opt-out", () => {
  const env = mainEnv({ PATH: "/bin", HOME: "/h", ACSTACK_AGENT_ROLE: "member", AC_TEAMS_SOCKET: "s", AC_TEAMS_TOKEN: "t", HERDR_ENV: "0", TMUX: "x" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  assert.equal(mainEnv({ HERDR_ENV: "1" }).HERDR_ENV, "1", "a real Herdr session keeps its marker");
});

test("promotion keeps the session, moves the transcript to the top-level folder, and keeps descendants", async () => {
  const f = await setup(4, 3, true);
  const launched: { command: string[]; env: Record<string, string> }[] = [];
  f.options.launchMain = async spec => { launched.push(spec); return "opened"; };
  try {
    const member = await f.team.handle("root", "agent", { ...launch, brief: "DELEGATE" }) as { id: string; sessionId: string; sessionFile: string };
    await until(() => f.team.live().length === 2);
    const nested = f.team.live().find(other => other.id !== member.id)!;
    await until(() => f.team.store.state.members[member.id].status === "idle");
    const original = f.team.store.state.members[member.id].sessionFile!;
    const result = await f.team.handle("root", "ui", { action: "promote", id: member.id });
    assert.match(String(result), /Promoted worker to a main session/);
    const promoted = f.team.store.state.members[member.id];
    const target = join(f.team.store.dir, "sessions", basename(original));
    assert.equal(promoted.role, "main");
    assert.equal(promoted.sessionId, member.sessionId);
    assert.equal(promoted.sessionFile, target);
    assert.equal(promoted.depth, 0);
    assert.equal(promoted.parent, undefined);
    assert.equal(promoted.promotion, undefined);
    assert.ok(!existsSync(original) && existsSync(target));
    assert.deepEqual(lines(target).at(-1)!.data, { team: f.team.store.state.id, member: member.id });
    assert.ok((await SessionManager.list(f.home, dirname(target))).some(session => session.id === member.sessionId), "Pi's session list shows the promoted transcript");
    assert.deepEqual(launched[0].command.slice(-2), ["--session", target]);
    assert.ok(!Object.keys(launched[0].env).some(key => key.startsWith("AC_TEAMS_") || key === "ACSTACK_AGENT_ROLE"));
    // The nested member keeps running, moves up a level, and stays under every main session's control.
    assert.equal(f.team.store.state.members[nested.id].status, "idle");
    assert.equal(f.team.store.state.members[nested.id].depth, 1);
    await assert.rejects(f.team.handle("root", "ui", { action: "promote", id: member.id }), /Only a member/);
    await f.team.handle("root", "agent", { action: "stop", id: nested.id });
  } finally { await f.close(); }
});

test("a sandboxed member is promoted only after the user confirms", async () => {
  const f = await setup(10, 2, true);
  f.options.launchMain = async () => "opened";
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    await until(() => f.team.store.state.members[member.id].status === "idle");
    f.team.store.update(state => { state.members[member.id].access = { read: [f.home], write: [], network: {} }; });
    await assert.rejects(f.team.handle("root", "ui", { action: "promote", id: member.id }), /confirm/);
    assert.equal(f.team.store.state.members[member.id].status, "idle", "a refused promotion leaves the member running");
    await f.team.handle("root", "ui", { action: "promote", id: member.id, confirmed: true });
    assert.equal(f.team.store.state.members[member.id].access, undefined);
    assert.equal(f.team.store.state.members[member.id].role, "main");
  } finally { await f.close(); }
});

for (const step of ["stopped", "moved", "role", "entry"]) test(`a promotion failing after the ${step} step rolls back to a stopped member`, async () => {
  const f = await setup(10, 2, true);
  f.options.launchMain = async () => "opened";
  f.options.promotionStep = name => { if (name === step) throw new Error(`injected at ${name}`); };
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    await until(() => f.team.store.state.members[member.id].status === "idle");
    const original = f.team.store.state.members[member.id].sessionFile!;
    await assert.rejects(f.team.handle("root", "ui", { action: "promote", id: member.id }), new RegExp(`injected at ${step}`));
    const after = f.team.store.state.members[member.id];
    assert.deepEqual([after.role, after.status, after.parent, after.depth, after.sessionFile, after.promotion], ["member", "stopped", "root", 1, original, undefined]);
    assert.match(after.error!, /Promotion failed/);
    assert.ok(existsSync(original) && !existsSync(join(f.team.store.dir, "sessions", basename(original))));
    if (step === "entry") assert.equal((lines(original).at(-1)!.data as { left?: boolean }).left, true, "the transcript no longer claims a main-session role");
  } finally { await f.close(); }
});

test("main sessions control members and each other; members cannot touch a main session", async () => {
  const f = await setup(10, 2, true);
  const launched: string[] = [];
  let shutdown = 0;
  f.options.launchMain = async spec => { launched.push(spec.id); return "opened"; };
  f.options.shutdown = () => { shutdown++; };
  try {
    const second = await addMain(f.team, f.home);
    await assert.rejects(addMain2(f.team, second.sessionId, f.home), /already in the team/);
    let client = await mainClient(f.team, second.id);
    assert.equal(f.team.store.state.members[second.id].status, "idle");
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    await assert.rejects(f.team.handle(member.id, "agent", { action: "stop", id: second.id }), /Only a main session or a member's ancestor/);
    await assert.rejects(f.team.handle(member.id, "agent", { action: "stop", id: "root" }), /Only a main session or a member's ancestor/);
    await client.request("agent", { action: "stop", id: member.id });
    assert.equal(f.team.store.state.members[member.id].status, "stopped");
    await client.request("agent", { action: "resume", id: member.id, brief: "continue", model: "test/model" });
    await until(() => f.team.store.state.members[member.id].status === "idle");
    await f.team.handle("root", "agent", { action: "stop", id: second.id });
    await until(() => f.team.store.state.members[second.id].status === "stopped");
    await assert.rejects(f.team.handle("root", "agent", { action: "resume", id: second.id, brief: "x", model: "test/model", analysis: "separate" }), /a main session keeps its own environment/);
    await f.team.handle("root", "agent", { action: "resume", id: second.id, brief: "x", model: "test/model" });
    assert.deepEqual(launched, [second.id]);
    client = await mainClient(f.team, second.id);
    await client.request("agent", { action: "stop", id: "root" });
    assert.equal(shutdown, 1, "stopping the owner asks its session to exit");
    client.close();
  } finally { await f.close(); }
});
async function addMain2(team: Coordinator, sessionId: string, home: string) {
  const probe = new Connection(team.socketPath, "join", team.store.state.key);
  await probe.open();
  try { return await probe.request("add_main", { sessionId, cwd: home }); } finally { probe.close(); }
}

test("leaving returns in-progress tasks and keeps the leaver's members manageable", async () => {
  const f = await setup(10, 2, true);
  try {
    const own = await f.team.handle("root", "agent", { ...launch, name: "own" }) as { id: string };
    await assert.rejects(f.team.handle("root", "ui", { action: "leave" }), /only main session/, "the last main session cannot strand live members");
    await f.team.handle("root", "agent", { action: "stop", id: own.id });
    const second = await addMain(f.team, f.home);
    const client = await mainClient(f.team, second.id);
    const member = await client.request("agent", launch) as { id: string };
    const task = await client.request("task", { action: "create", title: "Work", description: "Do it" }) as { id: string };
    await client.request("task", { action: "claim", id: task.id });
    await client.request("task", { action: "start", id: task.id });
    await client.request("ui", { action: "leave" });
    const state = f.team.store.state;
    assert.equal(state.tasks[task.id].status, "todo");
    assert.equal(state.tasks[task.id].owner, undefined);
    assert.equal(state.members[second.id].role, undefined);
    await assert.rejects(client.request("task", { action: "list" }), /disconnected|unavailable/i, "a session that left loses team access");
    await f.team.handle("root", "agent", { action: "stop", id: member.id });
    assert.equal(f.team.store.state.members[member.id].status, "stopped");
    client.close();
  } finally { await f.close(); }
});

for (const interactive of [false, true]) test(`explicit reload preserves mid-task resume intent without ordinary stop (${interactive ? "native" : "RPC"})`, async t => {
  const f = await setup(10, 2, interactive);
  const stop = t.mock.method(interactive ? TerminalAgent.prototype : RpcAgent.prototype, "stop", async () => { assert.fail("Reload must not use aborting or forceful stop"); });
  try {
    const idle = await f.team.handle("root", "agent", { ...launch, analysis: "separate" }) as { id: string; sessionFile: string };
    const busy = await f.team.handle("root", "agent", { ...launch, name: "busy", brief: "WAIT" }) as { id: string; sessionFile: string };
    await until(() => f.team.store.state.members[idle.id].status === "idle" && f.team.store.state.members[busy.id].status === "busy");
    const task = await f.team.handle(busy.id, "task", { action: "create", title: "Keep working" }) as { id: string };
    await f.team.handle(busy.id, "task", { action: "start", id: task.id });
    const savedTask = structuredClone(f.team.store.state.tasks[task.id]);
    await f.team.prepareReload(new AbortController().signal, () => true);
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "late" }), /reload is preparing/);
    await f.team.finishReload();
    assert.equal(stop.mock.calls.length, 0);
    assert.deepEqual([idle.id, busy.id].map(id => f.team.store.state.members[id].status), ["stopped", "stopped"]);
    assert.deepEqual([idle.id, busy.id].map(id => f.team.store.state.members[id].handover), ["idle", "busy"]);
    await f.team.close();
    stop.mock.restore();
    const next = await Coordinator.open(f.options);
    try {
      await until(() => [idle.id, busy.id].every(id => next.store.state.members[id].status === "idle"));
      assert.equal(next.store.state.members[idle.id].sessionFile, idle.sessionFile);
      assert.equal(next.store.state.members[busy.id].sessionFile, busy.sessionFile);
      assert.equal(next.store.state.members[idle.id].analysis, "separate");
      assert.deepEqual(next.store.state.tasks[task.id], savedTask);
      assert.ok(readFileSync(busy.sessionFile, "utf8").includes(handoverPrompt));
      assert.ok(!readFileSync(idle.sessionFile, "utf8").includes(handoverPrompt));
    } finally { await next.close(); }
  } finally { stop.mock.restore(); await f.close(); }
});

test("partial reload failure preserves survivors, reports cancellation failures, and unlocks launch", async t => {
  const f = await setup();
  const original = TeamProtocol.prototype.control;
  try {
    const parent = await f.team.handle("root", "agent", launch) as { id: string };
    const child = await f.team.handle(parent.id, "agent", { ...launch, name: "child" }) as { id: string };
    await f.team.prepareReload(new AbortController().signal, () => true);
    const control = t.mock.method(TeamProtocol.prototype, "control", function(this: TeamProtocol, id: string, command: string, args?: Record<string, unknown>, timeout?: number) {
      if (id === parent.id && command === "shutdown_reload") return Promise.reject(new Error("New input arrived; no shutdown requested"));
      if (id === parent.id && command === "cancel_reload") return Promise.reject(new Error("Cancel transport failed"));
      return original.call(this, id, command, args, timeout);
    });
    await assert.rejects(f.team.finishReload(), /New input arrived/);
    assert.equal(f.team.store.state.members[child.id].status, "stopped");
    assert.ok(["busy", "idle"].includes(f.team.store.state.members[parent.id].status));
    assert.notEqual(f.team.store.state.members.root.status, "stopped");
    await f.team.cancelReload();
    assert.ok(f.warnings.some(text => /Could not cancel reload.*worker.*Cancel transport failed/.test(text)));
    control.mock.restore();
    await f.team.handle("root", "agent", { ...launch, name: "still-usable" });
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("cancelling preparation leaves the team usable without stopping members", async t => {
  const f = await setup();
  const original = TeamProtocol.prototype.control;
  const cancel = new AbortController();
  try {
    const member = await f.team.handle("root", "agent", launch) as { id: string };
    const control = t.mock.method(TeamProtocol.prototype, "control", function(this: TeamProtocol, id: string, command: string, args?: Record<string, unknown>, timeout?: number) {
      if (command === "prepare_reload") { cancel.abort(); return Promise.resolve({ ready: false, resume: true }); }
      return original.call(this, id, command, args, timeout);
    });
    await assert.rejects(f.team.prepareReload(cancel.signal, () => true), /aborted/i);
    assert.ok(["busy", "idle"].includes(f.team.store.state.members[member.id].status));
    control.mock.restore();
    await f.team.handle("root", "agent", { ...launch, name: "still-usable" });
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("a new owner resumes each member to its recorded state after a handover", async () => {
  const f = await setup(10, 2, true);
  try {
    const second = await addMain(f.team, f.home);
    const idle = await f.team.handle("root", "agent", { ...launch, analysis: "separate" }) as { id: string; sessionFile: string };
    const busy = await f.team.handle("root", "agent", { ...launch, name: "busy", brief: "WAIT" }) as { id: string; sessionFile: string };
    const asking = await f.team.handle("root", "agent", { ...launch, name: "asking" }) as { id: string; sessionFile: string };
    await until(() => f.team.store.state.members[idle.id].status === "idle" && f.team.store.state.members[asking.id].status === "idle" && f.team.store.state.members[busy.id].status === "busy");
    f.team.recordEvent(asking.id, { type: "blocked", active: true });
    await f.team.close();
    assert.deepEqual([idle.id, busy.id, asking.id].map(id => f.team.store.state.members[id].handover), ["idle", "busy", "input"]);
    const options = { ...f.options, self: second.id, sessionId: second.sessionId, sessionFile: second.sessionFile };
    const next = await Coordinator.open(options);
    try {
      await until(() => [idle.id, busy.id, asking.id].every(id => ["idle", "busy"].includes(next.store.state.members[id].status) && next.store.state.members[id].handover === undefined));
      const prompts = (file: string) => lines(file).filter(entry => entry.type === "message").map(entry => ((entry.message as { content: { text: string }[] }).content[0].text));
      assert.ok(prompts(busy.sessionFile).at(-1)!.startsWith(handoverPrompt + "\n\n"));
      assert.ok(prompts(busy.sessionFile).at(-1)!.includes(`recipient ID: ${second.id}`));
      assert.equal(prompts(idle.sessionFile).length, 1, "idle members resume without a new prompt");
      assert.ok(prompts(idle.sessionFile)[0].startsWith("hello\n\n"));
      assert.equal(next.store.state.members[asking.id].needsInput, true);
      assert.equal(next.store.state.members.root.status, "stopped");
      const restored = next.store.state.members[idle.id];
      assert.equal(restored.analysis, "separate");
      assert.ok(readFileSync(`/proc/${restored.pid}/environ`, "utf8").split("\0").includes("PI_LENS_WARM_ATTACH=0"));
      const status = await next.handle(second.id, "agent", { action: "status", id: idle.id }) as { analysisPolicy: { warmAttach: string } };
      assert.equal(status.analysisPolicy.warmAttach, "0");
    } finally { await next.close(); }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("launch hands an existing task to the new member; its outcome reaches the delegator; a failed launch returns it", async () => {
  const f = await setup();
  try {
    const task = await f.team.handle("root", "task", { action: "create", title: "Parse input", description: "Parse" }) as { id: string };
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "broken", worktree: true, task: task.id }));
    assert.equal(f.team.store.state.tasks[task.id].owner, undefined, "a failed launch releases its reservation");
    const member = await f.team.handle("root", "agent", { ...launch, brief: "REPORT:briefed", task: task.id }) as { id: string };
    assert.deepEqual([f.team.store.state.tasks[task.id].owner, f.team.store.state.tasks[task.id].delegator], [member.id, "root"]);
    await assert.rejects(f.team.handle("root", "agent", { ...launch, name: "second", task: task.id }), /unowned or yours/);
    await until(() => !!f.team.store.state.messages.find(message => message.from === member.id)?.summary.includes("You own team task #1"));
    assert.match(f.team.store.state.messages.find(message => message.from === member.id)!.summary, /Start it only when its prerequisites are done/);
    await f.team.handle(member.id, "task", { action: "start", id: task.id });
    await f.team.handle(member.id, "task", { action: "complete", id: task.id, acceptance: true, summary: "Parsed all inputs" });
    const outcome = f.team.store.state.messages.at(-1)!;
    assert.deepEqual([outcome.summary, outcome.recipients], ["Parsed all inputs", ["root"]]);
    await until(() => f.notices.includes(outcome.seq));
  } finally { await f.close(); }
});
