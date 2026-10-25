#!/usr/bin/env node
// Deterministic RPC/native peer fixture. It exercises the real socket, never a model API.
import { createConnection } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const directory = arg("--session-dir");
mkdirSync(directory, { recursive: true });
const existing = process.argv.includes("--session") ? arg("--session") : undefined;
const sessionId = existing ? JSON.parse(readFileSync(existing, "utf8")).id : randomUUID();
const sessionFile = existing ?? join(directory, `${sessionId}.jsonl`);
if (!existing) writeFileSync(sessionFile, JSON.stringify({ id: sessionId }));
const socket = createConnection(process.env.AC_TEAMS_SOCKET);
const pending = new Map();
let buffer = "";
let errorOnAbort = false;
function request(operation, args) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.write(JSON.stringify({ id, member: process.env.AC_TEAMS_MEMBER, token: process.env.AC_TEAMS_TOKEN, operation, args }) + "\n");
  });
}
const native = !process.argv.includes("--mode");
const emit = event => {
  if (!native) process.stdout.write(JSON.stringify(event) + "\n");
  else if (event.type === "agent_start" || event.type === "agent_settled") void request("event", { type: event.type });
  else if (event.type === "message_end") void request("event", { type: "model_error", text: event.message.errorMessage });
};
socket.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (event.type === "command") { void run({ type: event.command, id: event.id, ...event.args }); continue; }
    if (event.type === "notice") { void request("ack", { through: event.through }); continue; }
    const entry = pending.get(event.id);
    if (entry) {
      pending.delete(event.id);
      if (event.error) entry.reject(new Error(event.error)); else entry.resolve(event.data);
    }
  }
});
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
socket.on("connect", () => {
  void request("join", { sessionId, sessionFile, tools: ["team_agent", "team_task", "team_message"], trusted: process.env.AC_TEAMS_TEST_UNTRUSTED !== "1" }).catch(() => process.exit(1));
});
async function run(command) {
  const data = command.type === "get_state" ? { sessionId, sessionFile, model: { provider: arg("--provider"), id: arg("--model"), name: "Fixture model" }, contextUsage: { tokens: 48000, contextWindow: 200000, percent: 24 } } : {};
  if (native) await request("control_result", { id: command.id, data });
  else emit({ type: "response", id: command.id, success: true, data });
  if (native && command.type === "shutdown") process.exit(0);
  if (command.type === "prompt") {
    if (native) {
      const session = JSON.parse(readFileSync(sessionFile, "utf8"));
      session.prompts = [...(session.prompts ?? []), command.message];
      writeFileSync(sessionFile, JSON.stringify(session));
    }
    errorOnAbort = command.message === "ERROR_ON_ABORT";
    emit({ type: "agent_start" });
    if (command.message.startsWith("DELEGATE")) {
      await request("agent", { action: "launch", name: "nested-review", brief: "REPORT:nested ready", model: "test/model" });
    }
    if (command.message.startsWith("REPORT:")) await request("message", { action: "send", recipients: ["root"], text: command.message.slice(7) });
    if (command.message === "ERROR") emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Provider rejected this model" } });
    if (command.message !== "WAIT") emit({ type: "agent_settled" });
  }
  if (command.type === "abort") {
    if (errorOnAbort) emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Provider failed during abort" } });
    emit({ type: "agent_settled" });
  }
}
if (!native) {
  const input = createInterface({ input: process.stdin });
  input.on("line", line => { void run(JSON.parse(line)); });
  input.on("close", () => process.exit(0));
}
