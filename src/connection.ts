import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Operation } from "./types.ts";

export interface Request { id: string; member: string; token: string; operation: Operation; args: unknown }
export function authentic(token: string, expected: string): boolean {
  const a = Buffer.from(token), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// A 100-item page can approach 10 MiB after JSON escaping; requests remain limited to 128 KiB.
const responseLimit = 16 * 1024 * 1024;
export function send(socket: Socket, value: Record<string, unknown>): void {
  const line = JSON.stringify(value) + "\n";
  if (socket.destroyed || socket.writableLength + Buffer.byteLength(line) > responseLimit) { socket.destroy(); return; }
  socket.write(line);
}
export function readLines(socket: Socket, receive: (value: unknown) => void, limit = 128 * 1024): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > limit) { socket.destroy(); return; }
      try { receive(JSON.parse(line)); }
      catch { socket.destroy(); return; }
    }
    if (Buffer.byteLength(buffer) > limit) socket.destroy();
  });
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export class Connection extends EventEmitter {
  private socket?: Socket;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private path: string;
  private member: string;
  private token: string;
  constructor(path: string, member: string, token: string) { super(); this.path = path; this.member = member; this.token = token; }
  async open(): Promise<void> {
    const socket = connect(this.path);
    this.socket = socket;
    readLines(socket, value => {
      if (!isRecord(value)) throw new Error("Invalid coordinator response");
      if (value.type === "notice" && Number.isSafeInteger(value.through)) { this.emit("notice", value.through, Array.isArray(value.messages) ? value.messages : []); return; }
      if (value.type === "command" && typeof value.id === "string" && typeof value.command === "string" && isRecord(value.args)) {
        this.emit("command", { id: value.id, command: value.command, args: value.args }); return;
      }
      if (typeof value.id !== "string") return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (typeof value.error === "string") pending.reject(new Error(value.error));
      else pending.resolve(value.data);
    }, responseLimit);
    socket.on("error", () => {});
    socket.once("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Coordinator disconnected")); }
      this.pending.clear();
      if (!this.closed) this.emit("disconnect");
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Coordinator connection timed out")); }, 10000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
  }
  request(operation: Operation, args: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Coordinator is unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Coordinator request timed out; inspect state before retrying mutations")); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      send(socket, { id, member: this.member, token: this.token, operation, args });
    });
  }
  close(): void { this.closed = true; this.socket?.destroy(); }
}
