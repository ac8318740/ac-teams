import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RpcAgent } from "../src/rpc-agent.ts";
import { readFileSync } from "node:fs";

const fixture = fileURLToPath(new URL("./fixtures/rpc-peer.mjs", import.meta.url));
function peer(hang = false) {
  return new RpcAgent({ command: process.execPath, cwd: process.cwd(), args: [fixture], env: { ...process.env, ...(hang ? { AC_TEAMS_TEST_HANG: "1" } : {}) } });
}
test("RPC correlates concurrent commands and keeps the pipe alive through agent_end until settlement", async () => {
  const agent = peer();
  const events: string[] = [];
  agent.on("event", event => events.push(event.type));
  try {
    assert.deepEqual(await Promise.all([agent.request("one"), agent.request("two")]), ["one", "two"]);
    await assert.rejects(agent.request("fail"), /expected failure/);
    const ended = new Promise<void>(resolve => agent.on("event", event => { if (event.type === "agent_end") resolve(); }));
    await agent.request("prompt"); await ended;
    assert.deepEqual(events, ["agent_start", "agent_end"]);
    assert.equal(agent.process.exitCode, null);
    const settled = new Promise<void>(resolve => agent.on("event", event => { if (event.type === "agent_settled") resolve(); }));
    await agent.request("settle"); await settled;
    assert.equal(events.at(-1), "agent_settled");
    assert.equal(await agent.request("second_assignment"), "second_assignment");
  } finally { await agent.stop(); }
  assert.equal(agent.process.exitCode, 0);
});
test("headless RPC dialogs are explicitly cancelled instead of hanging a member", async () => {
  const agent = peer();
  try {
    const received = new Promise<Record<string, unknown>>(resolve => agent.on("event", event => { if (event.type === "dialog_result") resolve(event); }));
    await agent.request("dialogs");
    assert.deepEqual(await received, { type: "dialog_result", cancelled: true, confirmed: false });
  } finally { await agent.stop(); }
});
test("a hung owned process escalates to SIGKILL without touching an unrelated process", { timeout: 12000 }, async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const agent = peer(true);
  const forced: string[] = [];
  agent.on("forced", signal => forced.push(signal));
  try {
    await agent.request("ready");
    await Promise.all([agent.stop(), agent.stop()]);
    assert.deepEqual(forced, ["SIGTERM", "SIGKILL"]);
    assert.equal(agent.process.signalCode, "SIGKILL");
    assert.equal(unrelated.exitCode, null);
    process.kill(unrelated.pid!, 0);
  } finally { await agent.stop(); unrelated.kill(); await once(unrelated, "close"); }
});
for (const afterExit of [false, true]) {
  test(`stop cleans inherited output pipes ${afterExit ? "after leader exit" : "during graceful shutdown"}`, { timeout: 12000 }, async () => {
    const agent = peer();
    const forced: string[] = [];
    agent.on("forced", signal => forced.push(signal));
    let closed = false;
    let descendant: number | undefined;
    let identity: string | undefined;
    void agent.exited.then(() => { closed = true; });
    try {
      descendant = await agent.request("descendant") as number;
      identity = processStat(descendant)?.[19];
      if (afterExit) {
        const exited = once(agent.process, "exit");
        agent.process.stdin.end();
        await exited;
        assert.equal(closed, false);
      }
      await agent.stop();
      assert.deepEqual(forced, ["SIGTERM", "SIGKILL"]);
      assert.equal(closed, true);
      // Reparented children may remain zombies until the host reaps them.
      assert.equal(processRunning(descendant), false);
    } finally {
      await cleanFixtureGroup(agent, descendant, identity);
    }
  });
}
function processStat(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function processRunning(pid: number): boolean {
  const state = processStat(pid)?.[0];
  return state !== undefined && state !== "Z";
}
async function cleanFixtureGroup(agent: RpcAgent, descendant?: number, identity?: string): Promise<void> {
  const stat = descendant ? processStat(descendant) : undefined;
  const group = String(agent.process.pid);
  if (identity && stat?.[19] === identity && stat[2] === group && stat[3] === group) {
    try { process.kill(-agent.process.pid!, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else if (agent.process.exitCode === null && agent.process.signalCode === null) {
    agent.process.kill("SIGKILL");
  }
  await agent.exited;
}
test("stop refuses stale identities and an unrelated session as group ownership", { timeout: 10000 }, async () => {
  const agent = peer();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  let descendant: number | undefined;
  let identity: string | undefined;
  try {
    descendant = await agent.request("descendant") as number;
    identity = processStat(descendant)![19];
    const exited = once(agent.process, "exit");
    agent.process.stdin.end();
    await exited;
    // Simulate a reused anchor PID plus an anchor that moved to another group/session.
    const ownership = agent as unknown as { groupMembers: Map<number, string> };
    ownership.groupMembers = new Map([
      [descendant, `${identity}0`],
      [unrelated.pid!, processStat(unrelated.pid!)![19]],
    ]);
    await assert.rejects(agent.stop(), /Cannot verify owned Pi process group; refusing to signal/);
    assert.equal(processRunning(descendant), true);
    assert.equal(processRunning(unrelated.pid!), true);
  } finally {
    try { await cleanFixtureGroup(agent, descendant, identity); }
    finally {
      const closed = once(unrelated, "close");
      unrelated.kill("SIGKILL");
      await closed;
    }
  }
});
test("missing Pi executable reports failure and rejects pending commands", async () => {
  const agent = new RpcAgent({ command: "/definitely/missing/pi", args: [], cwd: process.cwd(), env: process.env });
  const failure = once(agent, "failure");
  const request = assert.rejects(agent.request("get_state"), /exited|closed|EPIPE/);
  assert.match(String((await failure)[0]), /ENOENT/);
  await request;
  await agent.stop();
});
