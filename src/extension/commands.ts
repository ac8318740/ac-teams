import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamSnapshot } from "../ui/types.ts";
import { showTeamsPanel } from "../ui/panel.ts";
import { workerConfigPrompt } from "../ui/worker-config.ts";
import type { TeamSession } from "./session.ts";
import type { TeamPresentation } from "./presentation.ts";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { memberName, type Member } from "../types.ts";
import { cleanText } from "../ui/render.ts";

type NamedMember = Pick<Member, "id" | "name" | "status">;
const actions = ["panel", "teammate", "config", "back", "stop", "status", "join", "leave"];

export function resolveTeammate(members: NamedMember[], value: string): string | undefined {
  const key = value === "main" ? "root" : value;
  return members.find(member => member.id === key)?.id ?? members.find(member => member.name === key)?.id;
}

export function teamsCompletions(prefix: string, members: NamedMember[]): AutocompleteItem[] | null {
  if (!prefix.includes(" ")) return actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
  const config = /^config\s+(\S*)$/.exec(prefix);
  if (config && "display".startsWith(config[1])) return [{ value: "config display", label: "display", description: "Toggle task summary and agent selector" }];
  const match = /^(teammate|open)\s+(\S*)$/.exec(prefix);
  if (!match) return null;
  return members.filter(member => (member.id === "root" ? "main" : memberName(member)).startsWith(match[2]) || member.id.startsWith(match[2])).map(member => {
    const name = member.id === "root" ? "main" : memberName(member);
    return { value: `${match[1]} ${name}`, label: cleanText(name), description: `${member.status} · ${member.id}` };
  });
}

type CommandSession = Pick<TeamSession,
  "child" | "link" | "handle" | "joinTeam" | "leaveTeam" | "context" | "started" | "setContext">;

export function registerCommands(pi: ExtensionAPI, session: CommandSession,
  presentation: Pick<TeamPresentation, "host" | "configureDisplay">) {
  const { child, link, handle, joinTeam, leaveTeam } = session;
  const { host } = presentation;
  const panelView = { graph: false };
  pi.registerShortcut("ctrl+shift+left", {
    description: "Return to Main",
    handler: async ctx => {
      if (ctx.mode !== "tui") return;
      try { await host(ctx).visit("root"); }
      catch (error) { ctx.ui.notify(cleanText(error instanceof Error ? error.message : String(error)), "error"); }
    },
  });
  pi.registerCommand("teams", {
    description: "Team panel; /teams teammate <name-or-id>, config, back, stop, status, join [team-id], or leave",
    async getArgumentCompletions(prefix) {
      if (!prefix.includes(" ") || prefix.startsWith("config ")) return teamsCompletions(prefix, []);
      const context = session.context;
      if (!context) return null;
      try {
        const members = session.started ? (await handle("agent", { action: "list" }, context) as Pick<TeamSnapshot, "members">).members : [{ id: "root", status: "idle" as const }];
        return teamsCompletions(prefix, members);
      } catch { return null; }
    },
    async handler(args, ctx) {
      session.setContext(ctx);
      if (args.trim() === "config" || args.trim() === "config display") {
        if (ctx.mode !== "tui") { ctx.ui.notify("/teams config requires an interactive terminal", "error"); return; }
        try {
          if (args.trim() === "config display") { await presentation.configureDisplay(ctx); }
          else {
            pi.setActiveTools([...new Set([...pi.getActiveTools(), "team_config"])]);
            pi.sendUserMessage(workerConfigPrompt, { deliverAs: "followUp" });
          }
        }
        catch (error) { ctx.ui.notify(cleanText(String(error)), "error"); }
        return;
      }
      const joinArgs = /^join(?:\s+(.+))?$/.exec(args.trim());
      if (joinArgs || args.trim() === "leave") {
        try { await (joinArgs ? joinTeam(ctx, joinArgs[1]) : leaveTeam(ctx)); }
        catch (error) { ctx.ui.notify(cleanText(String(error instanceof Error ? error.message : error)), "error"); }
        return;
      }
      if (args.trim() === "stop") {
        if (child) throw new Error("A member can only stop its descendants using team_agent");
        await link(ctx);
        // Main sessions keep running; /teams stop stops members only.
        const { members } = await handle("agent", { action: "list" }, ctx) as Pick<TeamSnapshot, "members">;
        for (const member of members.filter(member => member.role === "member" && !member.parent && ["starting", "busy", "idle"].includes(member.status))) await handle("agent", { action: "stop", id: member.id }, ctx);
      }
      if (ctx.mode === "tui" && args.trim() !== "stop" && args.trim() !== "status") {
        if (!child) await link(ctx);
        const api = host(ctx);
        if (args.trim() === "back") await api.visit("root");
        else if (/^(teammate|open)\s+/.test(args.trim())) {
          const value = args.trim().replace(/^(teammate|open)\s+/, "");
          const members = (await api.snapshot()).members;
          const id = resolveTeammate(members, value);
          if (id) await api.visit(id);
          else ctx.ui.notify(`Unknown teammate: ${cleanText(value)}. Use autocomplete or /teams panel.`, "error");
        }
        else if (!args.trim() || args.trim() === "panel") await showTeamsPanel(ctx, api, panelView);
        else ctx.ui.notify("Usage: /teams [panel|teammate <name-or-id>|config|back|stop|status|join [team-id]|leave]", "info");
      } else {
        const status = await handle("agent", { action: "list" }, ctx);
        ctx.ui.notify(JSON.stringify(status, null, 2), "info");
      }
    },
  });
}
