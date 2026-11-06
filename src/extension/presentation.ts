import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { PanelHost, TeamSnapshot } from "../ui/types.ts";
import { memberName, type Message, type TaskView } from "../types.ts";
import { teamsHome } from "../team/snapshot.ts";
import { installTeamFooter, visitMember, showDisplayConfig } from "../ui/terminal-ui.ts";
import { readDisplaySettings, defaultDisplaySettings } from "../settings/config.ts";
import type { TeamSession } from "./session.ts";

type PresentationSession = Pick<TeamSession,
  "child" | "memberId" | "teamId" | "link" | "handle" | "started" | "needsInput" | "userAction" | "warn">;

export function createPresentation(pi: ExtensionAPI, session: PresentationSession) {
  const { child, memberId, teamId, link, handle } = session;
  const drafts = new Map<string, string>();
  const display = { ...defaultDisplaySettings };
  let disposeUI: (() => void) | undefined;
  async function snapshot(ctx: ExtensionContext, includeMessages = true): Promise<TeamSnapshot> {
    if (!session.started) return { members: [{ id: "root", cwd: ctx.cwd, depth: 0, status: ctx.isIdle() ? "idle" : "busy", notified: 0, needsInput: session.needsInput }], tasks: [], messages: [], limit: 10, depth: 2 };
    const status = await handle("agent", { action: "list" }, ctx) as Pick<TeamSnapshot, "members" | "limit" | "depth"> & { lastMessage: number };
    const tasks: TaskView[] = [];
    let total = 0;
    do {
      const page = await handle("task", { action: "list", offset: tasks.length, limit: 100 }, ctx) as { tasks: TaskView[]; total: number };
      tasks.push(...page.tasks); total = page.total;
      if (!page.tasks.length) break;
    } while (tasks.length < total);
    const messages = includeMessages ? await handle("message", { action: "history", after: Math.max(0, status.lastMessage - 100), limit: 100 }, ctx) as Message[] : [];
    return { members: status.members, limit: status.limit, depth: status.depth, tasks, messages };
  }
  function host(ctx: ExtensionContext): PanelHost {
    const userAction = (args: Parameters<TeamSession["userAction"]>[1]) => session.userAction(ctx, args);
    const api: PanelHost = {
      self: memberId(), child, drafts, snapshot: includeMessages => snapshot(ctx, includeMessages),
      visit: async id => {
        if (id === memberId()) return;
        if (!child) await link(ctx);
        const socket = child ? process.env.AC_TEAMS_TERMINAL_SOCKET : join(teamsHome(), teamId(ctx), "t.sock");
        if (!socket) throw new Error("This member has no live terminal transport");
        await visitMember(ctx, api, socket, id);
      },
      requestTask: text => userAction({ action: "task_request", text }),
      feedback: (task, text) => userAction({ action: "feedback", id: task.id, text }),
      resume: async id => { await userAction({ action: "resume", id }); },
      promote: async id => {
        const member = (await snapshot(ctx)).members.find(member => member.id === id);
        const confirmed = member?.access ? await ctx.ui.confirm("Promote a sandboxed member?", `${memberName(member)} will leave its sandbox and run as a main session with your full access.`) : false;
        if (member?.access && !confirmed) return;
        ctx.ui.notify(await userAction({ action: "promote", id, confirmed }), "info");
      },
    };
    return api;
  }
  function installUI(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    try { Object.assign(display, readDisplaySettings()); }
    catch (error) { Object.assign(display, defaultDisplaySettings); session.warn(String(error)); }
    disposeUI?.(); disposeUI = installTeamFooter(pi, ctx, host(ctx), display);
  }
  return {
    host, installUI,
    clearDrafts() { drafts.clear(); },
    dispose() { disposeUI?.(); disposeUI = undefined; },
    async configureDisplay(ctx: ExtensionContext) {
      Object.assign(display, readDisplaySettings());
      await showDisplayConfig(ctx, display);
    },
  };
}

export type TeamPresentation = ReturnType<typeof createPresentation>;
