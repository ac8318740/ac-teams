import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { CustomEditor, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, SettingsList } from "@earendil-works/pi-tui";
import { cleanText } from "./render.ts";
import { isLive, taskName, memberName } from "./types.ts";
import { saveDisplaySettings, type DisplaySettings } from "./config.ts";
import { modelContext, readTelemetry } from "./telemetry.ts";
import { renderTaskSummary } from "./task-summary.ts";
import type { PanelHost } from "./ui-types.ts";

const exec = promisify(execFile);
export async function visitMember(ctx: ExtensionContext, host: PanelHost, socket: string, id: string): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Live sessions require an interactive terminal");
  if (id === host.self) return;
  const member = (await host.snapshot()).members.find(member => member.id === id);
  if (!member || !isLive(member)) throw new Error(`Member ${id} is stopped or unavailable; resume it from /teams`);
  if (id !== "root" && !member.terminal) throw new Error("This member has no live terminal (it was launched headlessly)");
  if (host.self !== "root") {
    await exec("tmux", ["-S", socket, ...(id === "root" ? ["detach-client", "-s", host.self] : ["switch-client", "-t", id])], { timeout: 5000, maxBuffer: 65536 });
    return;
  }
  const code = await ctx.ui.custom<number>((tui, _theme, _keys, done) => {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    const child = spawn("tmux", ["-S", socket, "attach-session", "-t", id], { stdio: "inherit", env });
    let restored = false;
    const restore = (code: number) => {
      if (restored) return;
      restored = true; tui.start(); tui.requestRender(true); done(code);
    };
    child.once("error", () => restore(1));
    child.once("exit", code => restore(code ?? 1));
    return { render: () => [], invalidate() {}, dispose() { if (!restored) child.kill(); } };
  });
  if (code !== 0) throw new Error("Could not attach the live terminal; Main was restored");
}

export async function showDisplayConfig(ctx: ExtensionContext, settings: DisplaySettings): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const list = new SettingsList([
      { id: "tasks", label: "Task summary", currentValue: settings.tasks ? "On" : "Off", values: ["On", "Off"] },
      { id: "agents", label: "Agent selector", currentValue: settings.agents ? "On" : "Off", values: ["On", "Off"] },
    ], 4, getSettingsListTheme(), (id, value) => {
      if (id !== "tasks" && id !== "agents") return;
      try {
        const next = { ...settings, [id]: value === "On" };
        saveDisplaySettings(next);
        Object.assign(settings, next);
      } catch (error) {
        list.updateValue(id, settings[id] ? "On" : "Off");
        ctx.ui.notify(cleanText(String(error)), "error");
      }
    }, () => done());
    return {
      render(width) {
        const inner = Math.max(1, width - 4);
        const rows = [theme.fg("accent", theme.bold("Teams display · global")), theme.fg("dim", "Saves immediately for this and future sessions."), "", ...list.render(inner)];
        return ["╭" + "─".repeat(Math.max(0, width - 2)) + "╮", ...rows.map(line => {
          const text = truncateToWidth(line, inner);
          return "│ " + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + " │";
        }), "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"].map(line => truncateToWidth(line, width));
      },
      invalidate() { list.invalidate(); },
      handleInput(input) { list.handleInput(input === " " ? "\r" : input); tui.requestRender(); },
    };
  }, { overlay: true, overlayOptions: { width: 64, minWidth: 30, anchor: "center" } });
}

export function installTeamFooter(pi: ExtensionAPI, ctx: ExtensionContext, host: PanelHost, display: DisplaySettings): () => void {
  let members: Awaited<ReturnType<PanelHost["snapshot"]>>["members"] = [];
  let tasks: Awaited<ReturnType<PanelHost["snapshot"]>>["tasks"] = [];
  let selected: string | undefined, start = 0;
  let editor: CustomEditor | undefined;
  let redraw = () => {};
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  const ids = () => ["root", ...members.filter(member => member.id !== "root").map(member => member.id)];
  const slots = () => members.filter(member => member.id !== "root").length > 4 ? 3 : 4;
  const reveal = () => {
    if (selected === undefined || selected === "root") return;
    const index = ids().indexOf(selected) - 1;
    if (index < start) start = index;
    if (index >= start + slots()) start = index - slots() + 1;
    start = Math.max(0, start);
  };
  async function refresh() {
    try {
      if (!display.tasks && !display.agents) return;
      const next = await host.snapshot();
      if (disposed) return;
      members = next.members; tasks = next.tasks;
      if (selected && !ids().includes(selected)) { selected = undefined; if (editor) editor.focused = true; }
      start = Math.min(start, Math.max(0, ids().length - 1 - slots()));
      reveal(); redraw();
    } catch { /* The next refresh retries; explicit commands report connection errors. */ }
    finally { if (!disposed) timer = setTimeout(() => void refresh(), 1000); }
  }
  void refresh();
  ctx.ui.setWidget("ac-teams-tasks", (_tui, theme) => ({
    render: width => display.tasks ? renderTaskSummary(tasks, theme, width) : [],
    invalidate() {},
  }), { placement: "aboveEditor" });
  ctx.ui.setFooter((tui, theme, data) => {
    redraw = () => tui.requestRender();
    const unsubscribe = data.onBranchChange(redraw);
    return {
      render(width) {
        if (!display.agents && selected !== undefined) { selected = undefined; if (editor) editor.focused = true; }
        const branch = data.getGitBranch(), usage = ctx.getContextUsage()?.percent;
        const row = (id: string) => {
          const member = members.find(member => member.id === id);
          const assigned = tasks.find(task => task.owner === id && task.status === "in_progress") ?? tasks.find(task => task.owner === id && task.status !== "done");
          const status = member?.status === "busy" ? "working" : member?.status ?? "idle";
          const metrics = id === host.self ? readTelemetry(ctx) : member ?? {};
          const title = id === "root" ? "main" : memberName(member ?? { id });
          const description = `${title}  ${id === "root" ? "" : status + " · "}${modelContext(metrics)}${assigned ? ` · ${taskName(assigned)}` : ""}${member?.error || member?.activity ? ` · ${member.error || member.activity}` : ""}`;
          return theme.fg(selected === id || host.self === id ? "accent" : "muted", `${selected === id ? ">" : " "} ${host.self === id ? "●" : "○"} ${cleanText(description).replaceAll("\n", " ")}`);
        };
        const peers = ids().slice(1);
        return [theme.fg("dim", `${cleanText(ctx.cwd)}${branch ? ` (${cleanText(branch)})` : ""}`),
          theme.fg("dim", `${usage == null ? "Unknown" : usage.toFixed(1) + "%"} context · ${ctx.model?.id ?? "no model"} · ${pi.getThinkingLevel()}`),
          ...Array.from(data.getExtensionStatuses().values(), status => theme.fg("dim", cleanText(status))),
          ...(display.agents ? ["", row("root"), ...peers.slice(start, start + slots()).map(row),
            ...(peers.length > 4 ? [theme.fg("dim", `  ↑ ${start} above · ↓ ${Math.max(0, peers.length - start - slots())} below`)] : [])] : []),
        ].map(line => truncateToWidth(line, width));
      },
      invalidate() {},
      dispose() { disposed = true; clearTimeout(timer); unsubscribe(); },
    };
  });
  ctx.ui.setEditorComponent((tui, theme, keys) => {
    class TeamEditor extends CustomEditor {
      render(width: number) {
        const lines = super.render(width);
        return selected === undefined ? lines : lines.map(line => line.replace(renderFakeCursor(" "), " "));
      }
      handleInput(input: string) {
        if (!display.agents) { selected = undefined; this.focused = true; super.handleInput(input); return; }
        if (selected !== undefined) {
          const destinations = ids(), index = destinations.indexOf(selected);
          if (matchesKey(input, "down")) selected = destinations[Math.min(destinations.length - 1, index + 1)];
          else if (matchesKey(input, "up")) selected = index <= 0 ? undefined : destinations[index - 1];
          else if (matchesKey(input, "escape")) selected = undefined;
          else if (matchesKey(input, "enter")) {
            const id = selected; selected = undefined;
            void host.visit(id).catch(error => ctx.ui.notify(cleanText(String(error)), "error"));
          } else { selected = undefined; super.handleInput(input); }
          this.focused = selected === undefined; reveal(); redraw(); return;
        }
        if (matchesKey(input, "down") && !this.getText() && !this.isShowingAutocomplete()) {
          selected = "root"; start = 0; this.focused = false; redraw(); return;
        }
        super.handleInput(input);
      }
    }
    editor = new TeamEditor(tui, theme, keys);
    return editor;
  });
  return () => { disposed = true; clearTimeout(timer); ctx.ui.setWidget("ac-teams-tasks", undefined); ctx.ui.setFooter(undefined); ctx.ui.setEditorComponent(undefined); };
}
