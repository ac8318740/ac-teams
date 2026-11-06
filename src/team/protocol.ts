import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Socket } from "node:net";
import { authentic, isRecord, readLines, send } from "./connection.ts";
import { Store } from "./store.ts";
import { addMain } from "./sessions.ts";
import type { MemberLaunch } from "./launch.ts";
import { within } from "../sandbox/policy.ts";
import { extensionInventory, type ExtensionInventory } from "../settings/worker-extensions.ts";
import { isMain, isLive, type Message, type Member } from "../types.ts";

interface ProtocolHooks {
  closed(): boolean;
  changed(force?: string): void;
  disconnected(id: string): void;
  sessionDir(id: string): string;
  publicMember(member: Member): ReturnType<MemberLaunch["view"]>;
  handle(actor: string, operation: string, args: unknown): Promise<unknown>;
}
interface ProtocolOptions {
  extension: string;
  notice: (through: number, messages: Message[]) => void;
  warning: (message: string) => void;
}

/** Authenticated member channels, readiness, correlated commands, and durable notices. */
export class TeamProtocol {
  readonly sockets = new Map<string, Socket>();
  readonly connections = new Set<Socket>();
  readonly ready = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  readonly sessionDirs = new Map<string, string>();
  readonly extensionInventories = new Map<string, ExtensionInventory>();
  private controls = new Map<string, { member: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private notices = new Map<string, NodeJS.Timeout>();

  readonly self: string;
  private store: Store;
  private options: ProtocolOptions;
  private hooks: ProtocolHooks;

  constructor(self: string, store: Store, options: ProtocolOptions, hooks: ProtocolHooks) {
    this.self = self;
    this.store = store;
    this.options = options;
    this.hooks = hooks;
  }

  accept(socket: Socket): void {
    socket.on("error", () => {});
    if (this.hooks.closed()) { socket.destroy(); return; }
    this.connections.add(socket);
    let bound: string | undefined;
    socket.on("close", () => {
      this.connections.delete(socket);
      if (bound && this.sockets.get(bound) === socket) {
        this.sockets.delete(bound);
        this.hooks.disconnected(bound);
        if (isMain(this.store.state.members[bound])) this.extensionInventories.delete(bound);
        if (!this.hooks.closed()) {
          this.store.update(state => {
            const member = state.members[bound!];
            delete member.needsInput;
            // A main session is not a coordinator process: its socket is its liveness.
            if (isMain(member) && isLive(member)) member.status = member.status === "stopping" ? "stopped" : "interrupted";
          });
          this.hooks.changed();
        }
        for (const [id, pending] of this.controls) if (pending.member === bound) {
          clearTimeout(pending.timer); this.controls.delete(id); pending.reject(new Error("Native member disconnected"));
        }
      }
    });
    readLines(socket, value => {
      if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 128 || typeof value.member !== "string" || typeof value.token !== "string" || typeof value.operation !== "string") { socket.destroy(); return; }
      if (value.operation === "add_main" && !bound && !this.hooks.closed() && authentic(value.token, this.store.state.key)) {
        // The team key sits in the private store, so only an unsandboxed session of this user can join as a main session.
        const args = value.args;
        void Promise.resolve().then(() => {
          if (!isRecord(args) || typeof args.sessionId !== "string" || typeof args.cwd !== "string" || (args.sessionFile !== undefined && typeof args.sessionFile !== "string")) throw new Error("Invalid join request");
          const id = randomUUID().slice(0, 16);
          this.store.update(state => addMain(state, id, args.sessionId as string, args.sessionFile as string | undefined, args.cwd as string));
          return { id, token: this.store.state.members[id].token };
        }).then(data => send(socket, { id: value.id, data }), error => send(socket, { id: value.id, error: String(error instanceof Error ? error.message : error) }));
        return;
      }
      const member = this.store.state.members[value.member];
      const main = isMain(member);
      if ((this.hooks.closed() && value.operation !== "control_result") || !member || !(main || isLive(member)) || !authentic(value.token, member.token) || member.id === this.self || (bound && bound !== member.id)) { socket.destroy(); return; }
      bound = member.id;
      const operation = value.operation;
      const run = async () => {
        if (operation === "join") {
          const previous = this.sockets.get(member.id);
          if (previous && previous !== socket && !previous.destroyed) throw new Error("Member already connected");
          const args = value.args;
          if (!isRecord(args) || typeof args.sessionId !== "string" || typeof args.sessionFile !== "string" || !Array.isArray(args.tools) || !["team_agent", "team_task", "team_message"].every(name => Array.isArray(args.tools) && args.tools.includes(name))) throw new Error("Incomplete ac-teams readiness handshake");
          const loadedPaths = Array.isArray(args.extensionPaths) && args.extensionPaths.length <= 1024 && args.extensionPaths.every(path => typeof path === "string" && path.length <= 8192) ? args.extensionPaths as string[] : undefined;
          if (main) {
            this.extensionInventories.delete(member.id);
            if (loadedPaths) this.extensionInventories.set(member.id, await extensionInventory(member.cwd, undefined, loadedPaths.filter(path => path !== this.options.extension)));
          }
          if (main) {
            // A main session's identity never changes; its transcript may live anywhere the user keeps sessions.
            if (member.sessionId && args.sessionId !== member.sessionId) throw new Error("This main session's record belongs to another Pi session");
            this.store.update(state => {
              const current = state.members[member.id];
              current.status = "idle"; delete current.error;
              current.sessionId = args.sessionId as string; current.sessionFile = args.sessionFile as string;
            });
            this.sockets.set(member.id, socket);
            this.hooks.changed(member.id);
            this.notify(member.id);
            return { id: this.store.state.id, member: this.hooks.publicMember(this.store.state.members[member.id]), limit: this.store.state.limit, depth: this.store.state.depth };
          }
          // The session file chooses a host mount on resume, so it must stay in the directory ac-teams assigned.
          const assigned = this.sessionDirs.get(member.id) ?? this.hooks.sessionDir(member.id);
          if (!assigned || !within(resolve(args.sessionFile as string), assigned)) throw new Error("Member session file is outside its assigned directory");
          if (args.trusted !== true) throw new Error("Pi skipped protected project resources. Approve the member cwd with Pi's /trust command before retrying; ac-teams never auto-approves a project.");
          const seeded = this.extensionInventories.get(member.id);
          if (member.extensions) {
            if (!loadedPaths || !seeded) throw new Error("Missing actual loaded-extension handshake");
            const allowed = new Set([...seeded.entries.filter(entry => entry.enabled).map(entry => entry.path), this.options.extension]);
            if (loadedPaths.some(path => !allowed.has(path))) throw new Error("Member loaded an extension outside its parent seed");
            for (const required of member.extensions.required) {
              const entry = seeded.entries.find(entry => entry.id === required);
              if (!entry || !loadedPaths.includes(entry.path)) throw new Error(`Required extension did not load: ${required}`);
            }
            this.extensionInventories.set(member.id, { ...seeded, entries: seeded.entries.map(entry => ({ ...entry, enabled: entry.enabled && loadedPaths.includes(entry.path) })) });
          }
          this.store.update(state => {
            state.members[member.id].sessionId = args.sessionId as string;
            state.members[member.id].sessionFile = args.sessionFile as string;
          });
          this.sockets.set(member.id, socket);
          this.hooks.changed(member.id);
          this.ready.get(member.id)?.resolve();
          this.notify(member.id);
          return { id: this.store.state.id, member: this.hooks.publicMember(this.store.state.members[member.id]), limit: this.store.state.limit, depth: this.store.state.depth };
        }
        if (this.sockets.get(member.id) !== socket) throw new Error("Join before making team requests");
        if (operation === "control_result") {
          if (!isRecord(value.args) || typeof value.args.id !== "string") throw new Error("Invalid native command response");
          const pending = this.controls.get(value.args.id);
          if (!pending || pending.member !== member.id) throw new Error("Unknown native command response");
          clearTimeout(pending.timer); this.controls.delete(value.args.id);
          if (typeof value.args.error === "string") pending.reject(new Error(value.args.error.slice(0, 2000)));
          else pending.resolve(value.args.data);
          return {};
        }
        if (operation === "ack") {
          if (!isRecord(value.args) || !Number.isSafeInteger(value.args.through)) throw new Error("Invalid notification acknowledgement");
          this.ack(member.id, Number(value.args.through)); return {};
        }
        return this.hooks.handle(member.id, operation, value.args);
      };
      void run().then(data => send(socket, { id: value.id, data }), error => {
        if (operation === "join") this.ready.get(member.id)?.reject(error instanceof Error ? error : new Error("Member readiness failed"));
        send(socket, { id: value.id, error: error instanceof Error ? error.message : "Team request failed" });
      });
    });
  }
  control(member: string, command: string, args: Record<string, unknown> = {}, timeout = 10000): Promise<unknown> {
    const socket = this.sockets.get(member);
    if (!socket || socket.destroyed) return Promise.reject(new Error("Native member is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error(`Native ${command} timed out`)); }, timeout);
      this.controls.set(id, { member, resolve, reject, timer });
      send(socket, { type: "command", id, command, args });
    });
  }
  ack(id: string, through: number): void {
    const last = this.store.state.messages.at(-1)?.seq ?? 0;
    if (!Number.isSafeInteger(through) || through < 0 || through > last) throw new Error("Invalid notification cursor");
    if (this.hooks.closed()) throw new Error("Team is stopping");
    if (through <= this.store.state.members[id].notified) return;
    this.store.update(state => {
      const member = state.members[id];
      member.notified = through;
      if (member.watches) member.watches = member.watches.filter(watch => watch.seq === undefined || watch.seq > through);
    });
    // Batches are bounded, so posts beyond the acknowledged batch go out next.
    this.notify(id);
  }
  notify(id: string): void {
    if (this.hooks.closed() || this.notices.has(id)) return;
    this.notices.set(id, setTimeout(() => {
      this.notices.delete(id);
      const member = this.store.state.members[id];
      if (!member || !isLive(member)) return;
      const pending = this.store.state.messages.filter(message => message.seq > member.notified && message.recipients.includes(id));
      const batch = pending.slice(0, 20), through = batch.at(-1)?.seq;
      if (!through) return;
      try {
        if (id === this.self) this.options.notice(through, batch);
        else { const socket = this.sockets.get(id); if (socket) send(socket, { type: "notice", through, messages: batch }); }
      } catch (error) { this.options.warning(`Team notification remains in history: ${String(error)}`); }
    }, 50));
  }
  cancelNotices(): void {
    for (const timer of this.notices.values()) clearTimeout(timer);
    this.notices.clear();
  }
  close(): void {
    this.cancelNotices();
    for (const socket of this.connections) socket.destroy();
    for (const pending of this.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Team stopped"));
    }
    this.controls.clear();
  }
}
