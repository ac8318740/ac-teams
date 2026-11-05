import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visitMember } from "../src/terminal-ui.ts";
import type { PanelHost } from "../src/ui-types.ts";

// SAFETY: main navigation only reads mode and must never open a tmux UI.
const ctx = { mode: "tui", ui: { custom() { assert.fail("do not attach to a main through tmux"); } } } as unknown as ExtensionContext;
const main = { id: "root", role: "main" as const, cwd: "/repo", depth: 0, status: "idle" as const, notified: 0, sessionFile: "/sessions/main.jsonl", sessionId: "main-session" };
const host: PanelHost = { self: "peer", child: false, drafts: new Map(), snapshot: async () => ({ members: [main], tasks: [], messages: [], limit: 10, depth: 2 }), visit: async () => {}, promote: async () => {}, resume: async () => {}, requestTask: async () => "", feedback: async () => "" };
const agent = (pane = "w2:p7") => ({ agent: "pi", pane_id: pane, agent_session: { kind: "path", value: main.sessionFile } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "at-navigation-"));
  const original = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV };
  process.env.PATH = `${dir}:${original.PATH}`;
  process.env.HERDR_ENV = "1";
  const log = join(dir, "calls.jsonl"), response = join(dir, "response.json");
  writeFileSync(response, JSON.stringify({ agents: [agent()] }));
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const response = JSON.parse(fs.readFileSync(${JSON.stringify(response)}, "utf8"));
if (response.fail || (response.failFocus && args[1] === "focus")) { console.error("internal transport details"); process.exit(1); }
console.log(JSON.stringify({ result: response }));
`;
  writeFileSync(join(dir, "herdr"), script, { mode: 0o755 });
  writeFileSync(join(dir, "tmux"), script, { mode: 0o755 });
  return { set(value: unknown) { writeFileSync(response, JSON.stringify(value)); }, calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)), close() {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  } };
}

test("selecting a main focuses its live Herdr pane, including after a move", async () => {
  const f = fixture();
  try {
    await visitMember(ctx, host, "/unused", "root");
    assert.deepEqual(f.calls(), [["agent", "list"], ["agent", "focus", "w2:p7"]]);
    f.set({ agents: [agent("w9:p4")] });
    await visitMember(ctx, host, "/unused", "root");
    assert.deepEqual(f.calls().at(-1), ["agent", "focus", "w9:p4"]);
    f.set({ agents: [{ ...agent("w3:p2"), agent_session: { kind: "id", value: main.sessionId } }] });
    await visitMember(ctx, host, "/unused", "root");
    assert.deepEqual(f.calls().at(-1), ["agent", "focus", "w3:p2"]);
  } finally { f.close(); }
});

test("main navigation gives simple errors outside Herdr or when the destination is unavailable", async () => {
  const f = fixture();
  try {
    process.env.HERDR_ENV = "0";
    await assert.rejects(visitMember(ctx, host, "/unused", "root"), { message: "Open this main in its own terminal. Tab switching requires Herdr." });
    process.env.HERDR_ENV = "1";
    for (const response of [{ agents: [] }, {}, { fail: true }, { agents: [agent(), agent("w9:p4")] }]) {
      f.set(response);
      await assert.rejects(visitMember(ctx, host, "/unused", "root"), { message: "Could not find or switch to this main in Herdr. Open its tab manually." });
    }
    f.set({ agents: [{ agent: "pi", pane_id: "wrong", cwd: main.cwd }] });
    await assert.rejects(visitMember(ctx, host, "/unused", "root"));
    assert.ok(f.calls().every(args => args[1] !== "focus"), "never guess by working directory or name");
    f.set({ agents: [agent()], failFocus: true });
    await assert.rejects(visitMember(ctx, host, "/unused", "root"), { message: "Could not find or switch to this main in Herdr. Open its tab manually." });
  } finally { f.close(); }
});

test("workers still return to their attached main through tmux without Herdr", async () => {
  const f = fixture();
  try {
    process.env.HERDR_ENV = "0";
    await visitMember(ctx, { ...host, child: true }, "/team/t.sock", "root");
    assert.deepEqual(f.calls(), [["-S", "/team/t.sock", "detach-client", "-s", "peer"]]);
  } finally { f.close(); }
});
