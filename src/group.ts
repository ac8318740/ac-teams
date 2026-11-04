import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

type Row = {
  message?: { customType?: string; details?: { messages?: { kind?: string }[] } };
  toolName?: string; args?: { action?: unknown }; outputPad?: number;
  render(width: number): string[];
};
type Chat = { children: unknown[]; render(width: number): string[] };
const hook = Symbol.for("ac-teams.hook.notice-groups");
const widget = "ac-teams-notice-groups";
const groupStates = new WeakMap<Row, { expanded: boolean; hostExpanded: boolean }>();

const isRow = (child: unknown): child is Row => typeof child === "object" && child !== null && typeof (child as Row).render === "function";
const isNotice = (row: Row) => row.message?.customType === "ac-teams";
const isTeam = (child: unknown): child is Row => isRow(child) && (isNotice(child) || /^team_(agent|task|message)$/.test(child.toolName ?? ""));

type Post = { from?: string; summary?: string; task?: string; kind?: string };
type Labels = Readonly<Record<string, string>>;
const quiet = new Set(["list", "read", "status", "history", "search", "limits"]);
const oneLine = (text: unknown) => String(text ?? "").split("\n")[0]!.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** What the folded rows did, in plain words: the header phrases, then one line per post. Read-only calls add nothing. */
/** Transcript state carried across blocks, top to bottom: which tasks are done, and whether the session yielded on a wait. */
type Progress = { done: Set<string>; waiting: boolean; self: string };

function describe(rows: Row[], labels: Labels, progress: Progress): { header: string; posts: string[] } {
  const name = (id: unknown) => typeof id === "string" ? labels[id] ?? id : "?";
  const short = (id: unknown) => name(id).split(" ")[0]!;
  const phrases = new Map<string, string[]>();
  const add = (verb: string, ...items: string[]) => phrases.set(verb, [...(phrases.get(verb) ?? []), ...items]);
  const posts: string[] = [], watched = new Set<string>();
  for (const row of rows) {
    const args = (row.args ?? {}) as Record<string, unknown>, action = String(args.action ?? "");
    if (!row.toolName) {
      for (const post of (row.message?.details?.messages ?? []) as Post[]) {
        if (post.task) watched.add(post.task);
        if (post.kind === "outcome" && post.task) progress.done.add(post.task);
        // The first post after a wait is the one that started the next turn.
        const woke = progress.waiting ? ` (woke ${progress.self})` : "";
        progress.waiting = false;
        posts.push(`${name(post.from)} ${post.kind === "outcome" ? `completed ${name(post.task)}` : `→ ${post.task ? name(post.task) : "you"}`}${woke}: ${oneLine(post.summary)}`);
      }
      continue;
    }
    progress.waiting = row.toolName === "team_message" && action === "wait";
    if (Array.isArray(args.tasks) && action === "wait") for (const id of args.tasks) if (typeof id === "string") watched.add(id);
    if (quiet.has(action)) continue;
    else if (row.toolName === "team_agent" && action === "launch") add("launched", String(args.name ?? "a teammate"));
    else if (row.toolName === "team_task" && action === "create") add("created", ...(Array.isArray(args.tasks) ? args.tasks : [args]).map(() => "task"));
    else if (row.toolName === "team_message" && action === "wait") add("waiting on", ...(Array.isArray(args.tasks) ? args.tasks.map(short) : ["new posts"]));
    else if (row.toolName === "team_message" && action === "send") add("messaged", ...(Array.isArray(args.recipients) ? args.recipients.map(name) : [args.task ? short(args.task) : "team"]));
    else add(action, row.toolName === "team_task" ? short(args.id) : name(args.id));
  }
  const done = posts.filter(post => post.includes(" completed ")).length;
  const parts = [...phrases].map(([verb, items]) => verb === "created" ? `created ${items.length} task${items.length === 1 ? "" : "s"}` : `${verb} ${[...new Set(items)].join(", ")}`);
  if (posts.length) parts.push(done === posts.length ? `${done} completed` : `${posts.length} update${posts.length === 1 ? "" : "s"}`);
  // One word for where things stand: every task this block touched is done, the session is yielded on a wait, or work continues.
  const status = watched.size && [...watched].every(id => progress.done.has(id)) ? "done" : progress.waiting ? "waiting" : "working";
  return { header: [status, ...parts].join(" · "), posts };
}

/**
 * Folds each run of team tool rows and team notices into one block: a plain-words header, then one line per post.
 * Rows that draw nothing (an empty assistant turn between tool calls) stay inside a run; any visible other row ends it.
 * Global expansion shows native rows; individual row expansion stays inside its open group.
 */
export function groupTeamRows(children: unknown[], width: number, style: (header: string, posts: string[], width: number, warnings: string[]) => string[], labels: Labels, self = "this session", ours: (line: string) => boolean = () => false, requestRender: () => void = () => {}, hostExpanded = false): unknown[] {
  const out: unknown[] = [];
  const progress: Progress = { done: new Set(), waiting: false, self };
  for (let i = 0; i < children.length;) {
    if (!isTeam(children[i])) {
      // The user's message also wakes a yielded session; footers and other rows do not.
      if ((children[i] as object | null)?.constructor?.name === "UserMessageComponent") progress.waiting = false;
      out.push(children[i]); i++; continue;
    }
    let end = i, last = i;
    const team: Row[] = [], found: { index: number; text: string }[] = [];
    while (end < children.length) {
      const child = children[end];
      if (isTeam(child)) { team.push(child); last = end; }
      else {
        const lines = isRow(child) ? child.render(width).map(line => stripVTControlCharacters(line).trim()).filter(Boolean) : undefined;
        // Blank rows (spacers, an empty assistant turn) stay inside a run, and so do ac-teams' own warnings; anything else ends it.
        if (!lines) break;
        if (lines.length === 1 && ours(lines[0]!)) found.push({ index: end, text: lines[0]! });
        else if (lines.length) break;
      }
      end++;
    }
    const warnings = [...new Set(found.filter(item => item.index < last).map(item => item.text))];
    const members = children.slice(i, last + 1);
    // Describe in transcript order now, so progress reflects every earlier block; rendering only reads the result.
    const { header, posts } = describe(team, labels, progress);
    if (team.length < 2) out.push(...members);
    else {
      const first = team[0]!;
      let state = groupStates.get(first);
      if (!state) {
        state = { expanded: false, hostExpanded };
        groupStates.set(first, state);
      }
      if (state.hostExpanded !== hostExpanded) {
        state.hostExpanded = hostExpanded;
        state.expanded = false;
      }
      if (hostExpanded) { out.push(...members); i = last + 1; continue; }
      // Native rendering stays in charge of visibility, so /silent still hides a notice-only block.
      if (team.every(row => isNotice(row) && !row.render(width).length)) { i = last + 1; continue; }
      const group = new Container();
      group.addChild({
        render(width: number) {
          // Folding replaces native rows, so retain their current output padding.
          const pad = " ".repeat(Math.min(first.outputPad ?? 0, Math.floor(width / 2)));
          return ["", ...style(header, posts, width - pad.length * 2, warnings).map(line => pad + line + pad)];
        },
        invalidate() {},
        handleMouse(event) {
          if (event.type !== "click" || event.button !== "left" || event.y === 0) return undefined;
          state.expanded = !state.expanded;
          requestRender();
          return { handled: true };
        },
      });
      if (state.expanded) for (const member of members) group.addChild(member as Component);
      out.push(group);
    }
    i = last + 1;
  }
  return out;
}

/** Pi has no API to merge transcript rows, so this wraps the chat container's render through an invisible widget; any unexpected shape leaves the transcript native. */
export function bindNoticeGroups(ctx: ExtensionContext, labels: () => Labels, self: () => string, ours: (line: string) => boolean) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(widget, tui => {
    // SAFETY: Pi's private layout (document, then chat last); the shape checks below reject anything else.
    const chat = (tui as unknown as { children?: { children?: unknown[] }[] }).children?.[0]?.children?.at(-1) as Chat | undefined;
    if (chat && Array.isArray(chat.children) && typeof chat.render === "function" && !Object.hasOwn(chat, hook)) {
      const original = chat.render;
      const theme = ctx.ui.theme;
      const style = (header: string, posts: string[], width: number, warnings: string[]) => {
        const lines = [theme.fg("accent", theme.bold("ac-teams")) + theme.fg("muted", ` · ${header}`)];
        for (const warning of warnings) lines.push(theme.fg("warning", `  ${warning}`));
        for (const post of posts.slice(-5)) lines.push(theme.fg("text", `  ${post}`));
        if (posts.length > 5) lines.splice(1, 0, theme.fg("dim", `  … ${posts.length - 5} earlier`));
        return lines.map(line => truncateToWidth(line, width));
      };
      Object.defineProperty(chat, hook, { value: true });
      chat.render = function (this: Chat, width: number) {
        const children = this.children;
        this.children = groupTeamRows(children, width, style, labels(), self(), ours, () => tui.requestRender(), ctx.ui.getToolsExpanded());
        try { return original.call(this, width); } finally { this.children = children; }
      };
    }
    return { render: () => [], invalidate() {} };
  }, { placement: "belowEditor" });
}
