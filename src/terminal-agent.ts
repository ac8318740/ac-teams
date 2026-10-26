import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { processAlive, processIdentity } from "./store.ts";

const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function tmux(socket: string, args: string[], timeout = 5000): Promise<string> {
  const env = { ...process.env };
  delete env.TMUX; delete env.TMUX_PANE;
  const result = await exec("tmux", ["-S", socket, ...args], { env, timeout, maxBuffer: 65536 });
  return result.stdout.trim();
}
interface Options {
  id: string; dir: string; cwd: string; args: string[]; env: NodeJS.ProcessEnv; command?: string;
  request: (type: string, fields?: Record<string, unknown>, timeout?: number) => Promise<unknown>;
}
/** One native Pi process in a team-private tmux server; never recreates its transcript. */
export class TerminalAgent extends EventEmitter {
  readonly process: { pid?: number } = {};
  readonly socket: string;
  readonly exited: Promise<void>;
  private resolveExit!: () => void;
  private identity?: string;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private stopPromise?: Promise<void>;
  private files: string[] = [];
  private options: Options;
  constructor(options: Options) {
    super();
    this.options = options;
    this.socket = join(options.dir, "t.sock");
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }
  async start(): Promise<void> {
    const base = join(this.options.dir, `.terminal-${randomUUID()}`);
    const config = base + ".conf", script = base + ".sh";
    try {
      // Credentials travel in a private file, never in tmux's command-line arguments.
      writeFileSync(config, "set -g status off\nset -g prefix None\nset -s extended-keys always\nbind-key -n C-S-Left detach-client\n", { flag: "wx", mode: 0o600 });
      this.files.push(config);
      const exports = Object.entries(this.options.env)
        .filter(([key, value]) => (key.startsWith("AC_TEAMS_") || key === "HERDR_ENV") && value !== undefined)
        .map(([key, value]) => `export ${key}=${quote(value!)}`);
      const command = this.options.command ?? process.env.AC_TEAMS_PI ?? "pi";
      writeFileSync(script, [...exports,
        "exec " + [command, ...this.options.args].map(quote).join(" "), ""].join("\n"), { flag: "wx", mode: 0o600 });
      this.files.push(script);
      const pid = Number(await tmux(this.socket, ["-f", config, "new-session", "-d", "-s", this.options.id,
        "-c", this.options.cwd, "-x", String(process.stdout.columns || 120), "-y", String(process.stdout.rows || 40),
        "-P", "-F", "#{pane_pid}", "--", "/bin/sh", script]));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("tmux did not return a native member PID");
      this.process.pid = pid;
      this.identity = processIdentity(pid);
      if (!this.identity) throw new Error("Native Pi exited during terminal startup");
      this.timer = setInterval(() => {
        try { if (!processAlive(pid, this.identity)) void this.finish(); }
        catch (error) { clearInterval(this.timer); this.emit("failure", error); }
      }, 250);
    } catch (error) {
      await tmux(this.socket, ["kill-session", "-t", this.options.id]).catch(() => {});
      await this.finish();
      throw error;
    }
  }
  request(type: string, fields: Record<string, unknown> = {}, timeout = 10000): Promise<unknown> {
    return this.options.request(type, fields, timeout);
  }
  private async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await tmux(this.socket, ["kill-session", "-t", this.options.id]).catch(() => {});
    for (const file of this.files) {
      try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.emit("failure", error); }
    }
    this.files = [];
    this.emit("exit");
    this.resolveExit();
  }
  private async wait(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([this.exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    clearTimeout(timer);
    return result;
  }
  private signal(signal: NodeJS.Signals): void {
    const pid = this.process.pid;
    if (!pid || !this.identity) throw new Error("Cannot verify native Pi ownership; refusing to signal");
    if (processAlive(pid, this.identity)) process.kill(pid, signal);
  }
  stop(): Promise<void> { this.stopPromise ??= this.stopOnce(); return this.stopPromise; }
  private async stopOnce(): Promise<void> {
    if (this.closed) { await this.exited; return; }
    await this.request("abort", {}, 1000).catch(() => {});
    await this.request("shutdown", {}, 1000).catch(() => {});
    if (await this.wait(4000)) return;
    this.emit("forced", "SIGHUP");
    await tmux(this.socket, ["kill-session", "-t", this.options.id]).catch(() => {});
    if (await this.wait(1000)) return;
    this.emit("forced", "SIGTERM"); this.signal("SIGTERM");
    if (await this.wait(2000)) return;
    this.emit("forced", "SIGKILL"); this.signal("SIGKILL");
    if (!(await this.wait(2000))) throw new Error("Owned native Pi did not exit after SIGKILL");
  }
}
