import test from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { readLines } from "../src/connection.ts";

test("coalesced frames are bounded individually, not as one oversized frame", () => {
  const socket = new Socket();
  const received: unknown[] = [];
  try {
    readLines(socket, value => { received.push(value); }, 32);
    socket.emit("data", "{\"ok\":true}\n".repeat(20));
    assert.equal(received.length, 20);
    assert.equal(socket.destroyed, false);
  } finally { socket.destroy(); }
});

test("request framing still rejects oversized complete and incomplete lines", () => {
  for (const ending of ["", "\n"]) {
    const socket = new Socket();
    let received = false;
    try {
      readLines(socket, () => { received = true; });
      socket.emit("data", JSON.stringify({ text: "x".repeat(128 * 1024) }) + ending);
      assert.equal(socket.destroyed, true);
      assert.equal(received, false);
    } finally { socket.destroy(); }
  }
});
