import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionRuntime, DefaultResourceLoader, getPackageDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { RpcAgent } from "../src/members/rpc-agent.ts";
import { extensionInventory } from "../src/settings/worker-extensions.ts";
import { observeLoadedExtensions } from "../src/settings/loaded-extensions.ts";
import { TerminalAgent } from "../src/members/terminal-agent.ts";

test("loaded-extension observation always restores the method, including missing and unmatched results", () => {
  class FixtureLoader extends DefaultResourceLoader { override getExtensions() { return { extensions: [], errors: [], runtime: createExtensionRuntime() }; } }
  const original = FixtureLoader.prototype.getExtensions;
  for (const observed of [false, true]) {
    const finish = observeLoadedExtensions(FixtureLoader);
    assert.notEqual(FixtureLoader.prototype.getExtensions, original);
    if (observed) FixtureLoader.prototype.getExtensions();
    assert.equal(finish(() => false), undefined);
    assert.equal(FixtureLoader.prototype.getExtensions, original);
  }
});
test("stock Pi rejects extension factory errors before RPC readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "at-extension-error-")), agent = join(root, "agent"), failing = join(root, "required.ts");
  try {
    mkdirSync(agent);
    writeFileSync(failing, "export default function(){throw new Error('REQUIRED_FACTORY_FAILURE');}");
    const packageDir = getPackageDir(), bin = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin.pi;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(AC_TEAMS_|PI_LENS|BILI|BILLION_|ACP_|HERDR_)/.test(key)) delete env[key];
    Object.assign(env, { HOME: root, PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: "0" });
    const result = spawnSync(process.execPath, [join(packageDir, bin), "--mode", "rpc", "--offline", "--no-session", "-ne", "-ns", "-np", "--no-themes", "-e", failing], {
      cwd: root, env, encoding: "utf8", timeout: 15000, input: '{"id":"ready","type":"get_state"}\n',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /REQUIRED_FACTORY_FAILURE/);
    assert.doesNotMatch(result.stdout, /"success":true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const terminal of [false, true]) test(`stock Pi seeds only actual parent extensions, including hook-only safety (${terminal ? "TUI" : "RPC"})`, { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "at-loaded-")), agent = join(root, "agent"), childCwd = join(root, "child");
  mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(join(childCwd, ".pi", "extensions"), { recursive: true });
  const forbidden = join(root, "UNSELECTED_IMPORTED"), blocked = join(root, "BASH_EXECUTED"), witness = join(root, "witness.jsonl");
  const trap = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(forbidden)},'bad');export default ()=>{};`;
  writeFileSync(join(agent, "extensions", "not-parent-loaded.ts"), trap);
  writeFileSync(join(childCwd, ".pi", "extensions", "cwd-only.ts"), trap);
  writeFileSync(join(root, "AGENTS.md"), "LOADED_SET_INSTRUCTIONS: preserve these instructions.");
  writeFileSync(join(agent, "extensions", "guard.ts"), `import {appendFileSync} from 'node:fs';export default function(pi){pi.on('session_start',()=>appendFileSync(${JSON.stringify(witness)},JSON.stringify({member:process.env.AC_TEAMS_MEMBER,heap:process.env.NODE_OPTIONS})+'\\n'));pi.on('tool_call',event=>{if(event.toolName==='bash')return {block:true,reason:'Fixture safety policy blocks bash'};});}`);
  new ProjectTrustStore(agent).set(childCwd, true);
  const requests: { child: boolean; instructions: boolean }[] = [];
  const errors: unknown[] = [];
  let result: unknown;
  const events: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.headers.authorization, "Bearer fixture-secret");
      const text = JSON.stringify(body.messages), child = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === "user")).includes("SUBSET_CHILD_CHECK");
      requests.push({ child, instructions: text.includes("LOADED_SET_INSTRUCTIONS") });
      const toolResults = body.messages.filter((message: { role: string }) => message.role === "tool");
      if (!child && toolResults.length) result = toolResults.at(-1).content;
      const call = toolResults.length ? undefined : child ? { name: "bash", arguments: { command: `touch ${blocked}` } } : { name: "team_agent", arguments: { action: "launch", name: "seeded", brief: "SUBSET_CHILD_CHECK", cwd: childCwd, model: "fixture/model", extensions: { preset: "full" } } };
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: "Done" };
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: null }] }));
      res.end(frame({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
    } catch (error) { errors.push(error); res.writeHead(500); res.end("fixture failure"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-secret", models: [{ id: "model" }] } } }));
  mkdirSync(join(root, ".pi", "ac-teams"), { recursive: true });
  const guardId = (await extensionInventory(root, agent)).entries.find(entry => entry.path === join(agent, "extensions", "guard.ts"))!.id;
  writeFileSync(join(root, ".pi", "ac-teams", "config.json"), JSON.stringify({ workers: { defaultPreset: "full", required: [guardId], presets: { full: { extensions: "all", heapMb: 768 } } } }));
  const packageDir = getPackageDir(), bin = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin.pi;
  const cli = join(packageDir, bin), wrapper = join(root, "pi");
  writeFileSync(wrapper, `#!/bin/sh\nexport HOME='${root}'\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AC_TEAMS_|PI_LENS|BILI|BILLION_|ACP_|HERDR_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: root, PI_CODING_AGENT_DIR: agent, AC_TEAMS_PI: wrapper, NODE_OPTIONS: "--max-old-space-size=1024", HERDR_ENV: "0", PI_TELEMETRY: "0" });
  const args = ["--offline", "--no-session", "-ne", "-ns", "-np", "--no-themes", "-e", join(agent, "extensions", "guard.ts"), "-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--provider", "fixture", "--model", "model"];
  let rpc: RpcAgent | undefined, tui: TerminalAgent | undefined;
  try {
    if (terminal) {
      // Queue the native CLI prompt so cold startup cannot lose keystrokes before the editor is ready.
      tui = new TerminalAgent({ id: "parent", dir: root, cwd: root, command: wrapper, args: [...args, "Run parent subset check"], env, request: async () => { throw new Error("Not used by root fixture"); } });
      await tui.start();
    } else {
      rpc = new RpcAgent({ cwd: root, command: wrapper, args: ["--mode", "rpc", ...args], env });
      rpc.on("failure", error => errors.push(error));
      rpc.on("event", event => events.push(event));
      await rpc.request("get_state"); await rpc.request("prompt", { message: "Run parent subset check" });
    }
    const deadline = Date.now() + 20000;
    while ((requests.filter(request => request.child).length < 2 || result === undefined) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(errors, []);
    assert.ok(result, `parent receives a launch result: ${JSON.stringify({ requests, events }).slice(-4000)}`);
    assert.match(JSON.stringify(result), /"ids"|\\"ids\\"/);
    assert.equal(requests.filter(request => request.child).length, 2, JSON.stringify(result));
    assert.ok(requests.every(request => request.instructions));
    assert.ok(!existsSync(forbidden), "neither installed-but-unloaded nor child-cwd-only extension imported");
    assert.ok(!existsSync(blocked), "hook-only required safety extension blocks child bash");
    const starts = readFileSync(witness, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(starts.some(start => start.member && start.heap.includes("768")), "child receives selected hook and heap cap");
  } finally {
    if (rpc) await rpc.stop();
    if (tui) await tui.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
