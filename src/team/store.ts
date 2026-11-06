import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processAlive, processIdentity } from "../process.ts";
import type { TeamState, TaskArgs, MessageArgs, TaskView, Message, WatchResult } from "../types.ts";
import { code, ensureHome, flush, integer, migrate, object, privateFile, requireValue, teamsHome, text, validate } from "./snapshot.ts";
import { task } from "./tasks.ts";
import { message } from "./messages.ts";

export class Store {
  readonly dir: string;
  state: TeamState;
  private lock?: number;
  private closed = false;

  constructor(initial: TeamState, home = teamsHome()) {
    validate(initial);
    this.dir = join(resolve(home), initial.id);
    this.state = structuredClone(initial);
    ensureHome(resolve(home));
    try { mkdirSync(this.dir, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
    const dirFd = openSync(this.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireValue(fstatSync(dirFd).uid === process.getuid?.(), "Team directory belongs to another user");
      fchmodSync(dirFd, 0o700);
    } finally { closeSync(dirFd); }
    try {
      this.acquire();
      const path = join(this.dir, "state.json");
      let present = true;
      try { lstatSync(path); } catch (error) { if (code(error) !== "ENOENT") throw error; present = false; }
      if (present) {
        const fd = privateFile(path, constants.O_RDONLY);
        try {
          const stored: unknown = JSON.parse(readFileSync(fd, "utf8"));
          const migrated = migrate(stored);
          validate(stored);
          requireValue(stored.id === initial.id, "Snapshot team ID mismatch");
          if (migrated) flush(this.dir, stored);
          this.state = stored;
        } finally { closeSync(fd); }
      } else flush(this.dir, this.state);
    } catch (error) { this.close(); throw error; }
  }

  private acquire(): void {
    const path = join(this.dir, "owner.lock");
    try { this.lock = privateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); }
    catch (error) {
      if (code(error) !== "EEXIST") throw error;
      // Serialize stale-lock reapers; an interrupted recovery fails closed.
      const recoveryPath = join(this.dir, "owner.recovery");
      const recovery = privateFile(recoveryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        const fd = privateFile(path, constants.O_RDONLY);
        try {
          const owner: unknown = JSON.parse(readFileSync(fd, "utf8"));
          requireValue(object(owner) && integer(owner.pid, 1) && text(owner.identity), "Uncertain owner lock; refusing recovery");
          requireValue(!processAlive(owner.pid, owner.identity), "Team already has a live owner lock");
          const before = fstatSync(fd), current = lstatSync(path);
          requireValue(before.ino === current.ino && before.dev === current.dev, "Owner lock changed during recovery");
          unlinkSync(path);
        } finally { closeSync(fd); }
        this.lock = privateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      } finally { closeSync(recovery); unlinkSync(recoveryPath); }
    }
    const identity = processIdentity(process.pid);
    requireValue(identity, "Cannot identify owner process");
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, identity }));
    fsyncSync(this.lock);
  }

  update<T>(fn: (state: TeamState) => T): T {
    requireValue(!this.closed, "Store is closed");
    const draft = structuredClone(this.state);
    const result = fn(draft);
    validate(draft);
    requireValue(draft.id === this.state.id, "Cannot change team ID");
    flush(this.dir, draft);
    this.state = draft;
    return result;
  }

  task(actor: string, args: TaskArgs): TaskView | { tasks: TaskView[]; total: number } {
    requireValue(!this.closed && Object.hasOwn(this.state.members, actor), "Unknown actor or closed store");
    if (args.action === "list" || args.action === "read") return task(this.state, actor, args);
    return this.update(draft => task(draft, actor, args));
  }

  message(actor: string, args: MessageArgs, enveloped = false): Message | Message[] | WatchResult {
    requireValue(!this.closed && Object.hasOwn(this.state.members, actor), "Unknown actor or closed store");
    if (args.action === "history" || args.action === "search") return message(this.state, actor, args, enveloped);
    return this.update(draft => message(draft, actor, args, enveloped));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lock === undefined) return;
    const fd = this.lock; this.lock = undefined;
    try {
      const path = join(this.dir, "owner.lock");
      const mine = fstatSync(fd);
      try {
        const current = lstatSync(path);
        if (current.ino === mine.ino && current.dev === mine.dev) unlinkSync(path);
      } catch (error) { if (code(error) !== "ENOENT") throw error; }
    } finally { closeSync(fd); }
  }
}
