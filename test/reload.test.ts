import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReloadPause } from "../src/extension/reload.ts";

function fixture() {
  const messages: string[] = [];
  let idle = false, pending = false, blocked = false, draft = "", aborts = 0;
  const ctx = {
    mode: "tui", isIdle: () => idle, hasPendingMessages: () => pending,
    abort: () => { aborts++; },
    ui: { getEditorText: () => draft, setEditorText: (text: string) => { draft = text; } },
  } as unknown as ExtensionContext;
  const pause = createReloadPause({ sendUserMessage: text => { assert.equal(typeof text, "string"); messages.push(text as string); pending = true; } }, () => blocked);
  return { ctx, pause, messages, get aborts() { return aborts; }, get draft() { return draft; },
    set idle(value: boolean) { idle = value; }, set pending(value: boolean) { pending = value; },
    set blocked(value: boolean) { blocked = value; }, set draft(value: string) { draft = value; } };
}

test("reload waits for the tool boundary and final settlement, including Pi's synthetic abort turn", () => {
  const f = fixture();
  assert.deepEqual(f.pause.prepare(f.ctx), { ready: false, resume: true });
  assert.equal(f.aborts, 0);
  f.pause.boundary(f.ctx, true);
  assert.equal(f.aborts, 1);
  assert.equal(f.pause.state(f.ctx).ready, false);
  f.pause.boundary(f.ctx, false);
  assert.equal(f.aborts, 1, "synthetic aborted turn must not pause twice");
  f.idle = true;
  assert.deepEqual(f.pause.state(f.ctx), { ready: true, resume: true });
});

test("reload submits editor text and drains pending input before pausing", () => {
  const f = fixture();
  f.idle = true;
  f.draft = "Please run the integration tests";
  assert.deepEqual(f.pause.prepare(f.ctx), { ready: false, resume: true });
  assert.deepEqual(f.messages, ["Please run the integration tests"]);
  assert.equal(f.draft, "");
  f.pause.boundary(f.ctx);
  assert.equal(f.aborts, 0);
  f.pending = false;
  f.pause.boundary(f.ctx);
  assert.equal(f.aborts, 1);
  f.draft = "One more request";
  assert.equal(f.pause.state(f.ctx).ready, false);
  assert.deepEqual(f.messages, ["Please run the integration tests", "One more request"]);
  f.pause.started();
  f.pending = false;
  f.pause.boundary(f.ctx);
  assert.equal(f.aborts, 2, "a new run must pause at its own boundary");
});

test("input-blocked tools are not aborted, and cancelling before a boundary does not abort", () => {
  const f = fixture();
  f.blocked = true;
  f.pause.prepare(f.ctx);
  f.pause.boundary(f.ctx);
  assert.equal(f.aborts, 0);
  f.blocked = false;
  f.pause.cancel(f.ctx);
  f.pause.boundary(f.ctx);
  assert.equal(f.aborts, 0);
  assert.deepEqual(f.messages, []);
});

test("cancelling resumes paused work but leaves an originally idle member idle", () => {
  const f = fixture();
  f.pause.prepare(f.ctx);
  f.pause.boundary(f.ctx);
  f.idle = true;
  f.pause.cancel(f.ctx);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /continue your current task/);
  f.pending = false;
  assert.deepEqual(f.pause.prepare(f.ctx), { ready: true, resume: false });
  f.pause.cancel(f.ctx);
  assert.equal(f.messages.length, 1);
});

test("a cancelled draft submission does not block a later idle reload", () => {
  const f = fixture();
  f.idle = true;
  f.draft = "Run the tests";
  assert.equal(f.pause.prepare(f.ctx).ready, false);
  f.pause.cancel(f.ctx);
  f.idle = false;
  f.pause.started();
  f.pending = false;
  f.pause.boundary(f.ctx, false);
  f.idle = true;
  f.pause.settled(f.ctx);
  assert.deepEqual(f.pause.prepare(f.ctx), { ready: true, resume: false });
  assert.deepEqual(f.messages, ["Run the tests"]);
  assert.equal(f.aborts, 0);
});

test("cancelling between boundary and settlement resumes exactly once after settling", () => {
  const f = fixture();
  f.pause.prepare(f.ctx);
  f.pause.boundary(f.ctx, true);
  f.pause.cancel(f.ctx);
  assert.deepEqual(f.messages, []);
  f.pause.boundary(f.ctx, false);
  f.idle = true;
  f.pause.settled(f.ctx);
  f.pause.settled(f.ctx);
  assert.equal(f.messages.length, 1);
});

test("late follow-up input after a boundary abort is restarted rather than stranded", () => {
  const f = fixture();
  f.pause.prepare(f.ctx);
  f.pause.boundary(f.ctx, true);
  f.pending = true;
  f.idle = true;
  f.pause.settled(f.ctx);
  assert.equal(f.messages.length, 1);
  assert.equal(f.pause.state(f.ctx).ready, false);
  f.pause.started();
  f.pending = false;
  f.idle = false;
  f.pause.boundary(f.ctx, false);
  f.idle = true;
  f.pause.settled(f.ctx);
  assert.deepEqual(f.pause.state(f.ctx), { ready: true, resume: false });
});

test("a naturally completed final response is not resumed after reload or cancellation", () => {
  const f = fixture();
  f.pause.prepare(f.ctx);
  f.pause.boundary(f.ctx, false);
  assert.equal(f.aborts, 0, "natural settlement must drain late steering without an abort");
  f.idle = true;
  assert.deepEqual(f.pause.state(f.ctx), { ready: true, resume: false });
  f.pause.cancel(f.ctx);
  f.pause.settled(f.ctx);
  assert.deepEqual(f.messages, []);
});
