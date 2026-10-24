import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

function groupIdentity(pid: number, group: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[2] === String(group) && fields[3] === String(group) && /^\d+$/.test(fields[19] ?? "")
      ? fields[19] : undefined;
  } catch { return undefined; } // Unreadable or vanished processes cannot establish ownership.
}

interface Response { type: string; id?: string; success?: boolean; error?: string; data?: unknown; method?: string }
export interface SpawnOptions { cwd: string; args: string[]; env: NodeJS.ProcessEnv; command?: string }

/** Owns one child's pipes for its entire lifetime, including idle periods. */
export class RpcAgent extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private buffer = "";
  private pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stopPromise?: Promise<void>;
  private closed = false;
  private leaderIdentity?: string;
  private groupMembers = new Map<number, string>();

  constructor(options: SpawnOptions) {
    super();
    this.process = spawn(options.command ?? process.env.AC_TEAMS_PI ?? "pi", options.args, {
      cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: "pipe",
    });
    this.process.once("spawn", () => {
      if (process.platform === "linux" && this.process.pid) {
        this.leaderIdentity = groupIdentity(this.process.pid, this.process.pid);
        this.captureGroup();
      }
    });
    this.exited = new Promise(resolve => this.process.once("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Pi process exited")); }
      this.pending.clear();
      this.emit("exit");
      resolve();
    }));
    this.process.once("error", error => this.emit("failure", error));
    this.process.stdin.on("error", error => this.emit("failure", error));
    this.process.stderr.resume(); // Always drain; provider output may contain private data.
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
        this.emit("failure", new Error("Pi RPC output exceeded 1 MiB"));
        this.process.kill("SIGTERM");
        this.buffer = "";
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line) as Response); }
        catch { this.emit("failure", new Error("Invalid Pi RPC output")); }
      }
    });
  }
  private receive(event: Response): void {
    if (!event || typeof event.type !== "string") throw new Error("Invalid event");
    if (event.type === "response" && event.id) {
      this.captureGroup();
      const entry = this.pending.get(event.id);
      if (!entry) return;
      this.pending.delete(event.id);
      clearTimeout(entry.timer);
      if (event.success) entry.resolve(event.data);
      else entry.reject(new Error(event.error ?? "Pi command failed"));
    } else if (event.type === "extension_ui_request") {
      if (["confirm", "select", "input", "editor"].includes(event.method ?? "")) {
        this.write({ type: "extension_ui_response", id: event.id, cancelled: true, confirmed: false });
      }
    } else this.emit("event", event);
  }
  private write(value: Record<string, unknown>): void {
    if (this.process.stdin.destroyed || this.process.stdin.writableEnded) throw new Error("Pi input is closed");
    this.process.stdin.write(JSON.stringify(value) + "\n");
  }
  request(type: string, fields: Record<string, unknown> = {}, timeout = 10000): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi ${type} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...fields, type, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }
  private async wait(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([this.exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    if (timer) clearTimeout(timer);
    return result;
  }
  // shortcut: snapshots miss detached/uncaptured descendants and identity races; use OS containment if required.
  private captureGroup(): void {
    const pid = this.process.pid;
    if (!pid || !this.leaderIdentity || groupIdentity(pid, pid) !== this.leaderIdentity) return;
    let members: string[];
    try { members = readdirSync("/proc"); } catch { return; }
    const snapshot = new Map<number, string>();
    for (const member of members) {
      if (!/^\d+$/.test(member)) continue;
      const identity = groupIdentity(Number(member), pid);
      if (identity) snapshot.set(Number(member), identity);
    }
    // A leader verified on both sides of the scan anchors these identities to our original group.
    if (groupIdentity(pid, pid) === this.leaderIdentity) {
      for (const [member, identity] of snapshot) this.groupMembers.set(member, identity);
    }
  }
  private signal(signal: NodeJS.Signals): void {
    if (this.closed || !this.process.pid) return;
    if (process.platform === "linux") {
      this.captureGroup();
      if (![...this.groupMembers].some(([pid, identity]) => groupIdentity(pid, this.process.pid!) === identity)) {
        throw new Error("Cannot verify owned Pi process group; refusing to signal");
      }
    } else if (this.process.exitCode !== null || this.process.signalCode !== null) {
      throw new Error("Cannot verify owned Pi process after leader exit; refusing to signal");
    }
    try { process.kill(process.platform === "win32" ? this.process.pid : -this.process.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  private async stopOnce(): Promise<void> {
    if (this.closed) return;
    this.captureGroup();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      await this.request("clear_queue", {}, 1000).catch(() => {});
      await this.request("abort", {}, 1000).catch(() => {});
      this.captureGroup();
      this.process.stdin.end();
    }
    if (await this.wait(4000)) return;
    this.emit("forced", "SIGTERM");
    this.signal("SIGTERM");
    if (await this.wait(2000)) return;
    this.emit("forced", "SIGKILL");
    this.signal("SIGKILL");
    if (!(await this.wait(2000))) throw new Error("Owned Pi did not exit after SIGKILL");
  }
}
