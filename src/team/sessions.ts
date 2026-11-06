import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Store } from "./store.ts";
import type { TeamProtocol } from "./protocol.ts";
import type { CoordinatorOptions } from "./options.ts";
import { memberConfigDir } from "../sandbox/runtime.ts";
import { launchMain, mainEnv, teamEntryType, type TeamEntry } from "../members/main-terminal.ts";
import { isMain, isLive, memberName, type Member, type TeamState } from "../types.ts";

/** Adds a main session record; the caller writes the team entry into its transcript. */
export function addMain(state: TeamState, id: string, sessionId: string, sessionFile: string | undefined, cwd: string): void {
  if (Object.values(state.members).some(member => member.sessionId === sessionId)) throw new Error("This Pi session is already in the team");
  const names = new Set(Object.values(state.members).map(member => member.name));
  let number = 1;
  do { number++; } while (names.has(`main-${number}`));
  state.members[id] = { id, name: `main-${number}`, role: "main", depth: 0, token: randomUUID(), cwd, status: "stopped", notified: state.messages.at(-1)?.seq ?? 0, sessionId, sessionFile };
}

/** Main-session identity, promotion, transcript moves, and rollback. */
export class TeamSessions {
  private store: Store;
  private self: string;
  private options: CoordinatorOptions;
  private protocol: TeamProtocol;
  private stopMember: (id: string) => Promise<void>;
  private liveMembers: () => Member[];

  constructor(store: Store, self: string, options: CoordinatorOptions, protocol: TeamProtocol, stopMember: (id: string) => Promise<void>, liveMembers: () => Member[]) {
    this.store = store;
    this.self = self;
    this.options = options;
    this.protocol = protocol;
    this.stopMember = stopMember;
    this.liveMembers = liveMembers;
  }
  /** The top-level session folder: Main's session directory without ac-teams nesting. */
  private topSessionDir(): string {
    return resolve(this.options.sessionDir ?? join(this.store.dir, "sessions")).replace(/\/ac-teams\/[^/]+\/[^/]+$/, "");
  }
  /** Opens a main session's transcript in its own terminal with a clean environment. */
  private async openMain(id: string): Promise<string> {
    const member = this.store.state.members[id];
    const notice = await (this.options.launchMain ?? launchMain)({
      id, name: memberName(member), cwd: member.cwd, socket: join(this.store.dir, `m-${id}.sock`), env: mainEnv(),
      command: [this.options.command ?? process.env.AC_TEAMS_PI ?? "pi", "--session", member.sessionFile!],
    });
    this.store.update(state => { state.members[id].status = "starting"; delete state.members[id].error; });
    return notice;
  }
  async resumeMain(id: string): Promise<string> {
    const member = this.store.state.members[id];
    if (isLive(member) || this.protocol.sockets.has(id)) throw new Error("That main session is already running");
    return this.openMain(id);
  }
  async stopMain(id: string): Promise<void> {
    if (id === this.self) {
      if (!this.options.shutdown) throw new Error("This main session cannot be stopped remotely");
      this.options.shutdown(); return;
    }
    if (!this.protocol.sockets.has(id)) throw new Error("That main session is not running");
    this.store.update(state => { state.members[id].status = "stopping"; });
    await this.protocol.control(id, "shutdown");
  }
  /** Stops a member and relaunches its transcript as a main session. Each step is recorded so a failure can roll back. */
  async promote(id: string, confirmed: boolean): Promise<string> {
    const member = this.store.state.members[id];
    if (!member || member.role !== "member") throw new Error("Only a member can be promoted");
    if (!member.sessionFile) throw new Error("The member has no native session file yet");
    if (member.promotion) throw new Error("The member is already being promoted");
    if (member.access && !confirmed) throw new Error("Promoting a sandboxed member runs it with your full access; confirm before promoting");
    const original = member.sessionFile;
    const step = async (name: NonNullable<Member["promotion"]>["step"], change: (current: Member) => void = () => {}) => {
      this.store.update(state => { const current = state.members[id]; change(current); current.promotion = { ...current.promotion!, step: name }; });
      await this.options.promotionStep?.(name);
    };
    this.store.update(state => { state.members[id].promotion = { step: "stopped", sessionFile: original, parent: member.parent, access: member.access, provider: member.provider }; });
    try {
      await this.stopMember(id);
      await step("stopped");
      const target = join(this.topSessionDir(), basename(original));
      if (existsSync(target)) throw new Error(`A session file already exists at ${target}`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      moveFile(original, target);
      await step("moved", current => { current.sessionFile = target; });
      rmSync(memberConfigDir(id), { recursive: true, force: true });
      await step("role", current => {
        current.role = "main"; current.depth = 0; current.token = randomUUID();
        delete current.parent; delete current.access; delete current.provider; delete current.handover;
      });
      this.store.update(recomputeDepths);
      const entry: TeamEntry = { team: this.store.state.id, member: id };
      SessionManager.open(target).appendCustomEntry(teamEntryType, entry);
      await step("entry");
      const notice = await this.openMain(id);
      this.store.update(state => { delete state.members[id].promotion; });
      return `Promoted ${memberName(member)} to a main session. ${notice}`;
    } catch (error) {
      this.rollback(id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  /** Returns a partly promoted member to a stopped member with its original transcript path. */
  rollback(id: string, reason: string): void {
    const promotion = this.store.state.members[id].promotion!;
    const current = this.store.state.members[id].sessionFile;
    try {
      if (current && current !== promotion.sessionFile && existsSync(current)) {
        // The moved transcript may already claim main-session membership; record the departure first.
        if (promotion.step === "entry") SessionManager.open(current).appendCustomEntry(teamEntryType, { team: this.store.state.id, member: id, left: true } satisfies TeamEntry);
        moveFile(current, promotion.sessionFile);
      }
    } catch (error) { this.options.warning(`Promotion rollback could not restore ${promotion.sessionFile}: ${String(error)}`); }
    this.store.update(state => {
      const member = state.members[id];
      Object.assign(member, { role: "member", sessionFile: promotion.sessionFile, parent: promotion.parent, access: promotion.access, provider: promotion.provider, status: "stopped", error: `Promotion failed: ${reason}`.slice(0, 2000) });
      for (const key of ["parent", "access", "provider"] as const) if (member[key] === undefined) delete member[key];
      if (member.parent && !state.members[member.parent]) delete member.parent;
      delete member.promotion;
      recomputeDepths(state);
    });
  }
  /** A main session leaves: its in-progress tasks return to todo and its record keeps history without a role. */
  leave(actor: string): string {
    const state = this.store.state;
    const others = Object.values(state.members).filter(member => isMain(member) && member.id !== actor);
    if (!others.length && this.liveMembers().length) throw new Error("You are the only main session and members are still live; stop them first");
    this.store.update(next => {
      for (const task of Object.values(next.tasks)) if (task.owner === actor && task.status !== "done") { task.status = "todo"; delete task.owner; }
      const member = next.members[actor];
      delete member.role;
      member.status = "stopped";
    });
    return `Left team ${state.id}`;
  }
}

function moveFile(from: string, to: string): void {
  try { renameSync(from, to); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to, constants.COPYFILE_EXCL); unlinkSync(from);
  }
}
/** Depth follows ancestry, so a promotion moves the promoted member's descendants up. */
function recomputeDepths(state: TeamState): void {
  const depth = (member: Member, seen = 0): number => member.parent && state.members[member.parent] && seen < 64 ? depth(state.members[member.parent], seen + 1) + 1 : 0;
  for (const member of Object.values(state.members)) member.depth = depth(member);
}
