import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { cleanText, messageDetails, messagePresentation, styleRecordLine, teamToolDetails, teamToolPresentation } from "./render.ts";

type Row = {
  message?: { customType?: string; content?: unknown; details?: { messages?: unknown[] } };
  toolName?: string; args?: { action?: unknown }; outputPad?: number;
  result?: { details?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
  render(width: number): string[];
};
type Chat = { children: unknown[]; render(width: number): string[] };
type Expansion = { expanded: boolean; hostExpanded: boolean };
type Labels = Readonly<Record<string, string>>;
const hook = Symbol.for("ac-teams.hook.notice-groups");
const widget = "ac-teams-notice-groups";
const groupStates = new WeakMap<Row, Expansion>();
const actionStates = new WeakMap<Row, Expansion[]>();
const isRow = (child: unknown): child is Row => typeof child === "object" && child !== null && typeof (child as Row).render === "function";
const isNotice = (row: Row) => row.message?.customType === "ac-teams";
const isTeam = (child: unknown): child is Row => isRow(child) && (isNotice(child) || /^team_(agent|task|message)$/.test(child.toolName ?? ""));
const expansion = (state: Expansion | undefined, hostExpanded: boolean): Expansion => !state || state.hostExpanded !== hostExpanded ? { expanded: hostExpanded, hostExpanded } : state;

function actions(row: Row, labels: Labels, self: string) {
  if (row.toolName) return [{ ...teamToolPresentation(row.toolName, row.args, row.result, labels, self), details: teamToolDetails(row.toolName, row.args, row.result, labels, self) }];
  const posts = row.message?.details?.messages ?? [];
  return posts.length ? posts.map(post => ({ ...messagePresentation(post, labels, self), details: messageDetails(post, labels, self) })) : [{ title: "Team update", body: [cleanText(String(row.message?.content ?? ""))], category: "team update", details: [cleanText(String(row.message?.content ?? ""))] }];
}

function activitySummary(items: ReturnType<typeof actions>): string {
  const counts = new Map<string, number>();
  const messages: Record<string, string> = { "received message": "Received", "sent message": "Sent", "message send": "Sending", "failed message send": "Failed to send", "undelivered message": "Not delivered:" };
  for (const item of items) {
    const description = messages[item.category] ?? item.activity ?? item.title.split(" · ")[0]!;
    counts.set(description, (counts.get(description) ?? 0) + 1);
  }
  return [...counts].map(([description, count], index) => {
    const text = Object.values(messages).includes(description) ? `${description} ${count} message${count === 1 ? "" : "s"}` : `${description}${count > 1 ? ` (${count} times)` : ""}`;
    return index ? text[0]!.toLowerCase() + text.slice(1) : text;
  }).join("; ");
}

function treeLines(text: string, width: number, first: string, rest = first): string[] {
  if (width <= 0) return [""];
  const indent = Math.min(first.length, width - 1);
  return wrapTextWithAnsi(cleanText(text), width - indent).map((line, i) => truncateToWidth((i ? rest : first).slice(0, indent) + line, width));
}

/** Group heading, every action, then independently expandable details. Invisible rows stay invisible. */
export function groupTeamRows(children: unknown[], width: number, style: (header: string, width: number, warnings: string[]) => string[], labels: Labels, self = "this session", ours: (line: string) => boolean = () => false, requestRender: () => void = () => {}, hostExpanded = false, formatDetail: (line: string) => string = line => line): unknown[] {
  const out: unknown[] = [];
  const actor = Object.keys(labels).find(id => id === self || labels[id] === self) ?? (self === "this session" ? "root" : self);
  for (let i = 0; i < children.length;) {
    if (!isTeam(children[i])) { out.push(children[i]); i++; continue; }
    let end = i, last = i;
    const team: Row[] = [], found: { index: number; text: string }[] = [];
    while (end < children.length) {
      const child = children[end];
      if (isTeam(child)) { team.push(child); last = end; }
      else {
        const lines = isRow(child) ? child.render(width).map(line => stripVTControlCharacters(line).trim()).filter(Boolean) : undefined;
        if (!lines) break;
        if (lines.length === 1 && ours(lines[0]!)) found.push({ index: end, text: lines[0]! });
        else if (lines.length) break;
      }
      end++;
    }
    const warnings = [...new Set(found.filter(item => item.index < last).map(item => item.text))];
    // /silent is owned by native message rendering, even in a mixed tool/message group.
    const visible = team.filter(row => !isNotice(row) || row.render(width).length);
    const items = visible.flatMap(row => {
      const states = actionStates.get(row) ?? [];
      actionStates.set(row, states);
      return actions(row, labels, actor).map((item, index) => {
        const state = states[index] = expansion(states[index], hostExpanded);
        return { ...item, state };
      });
    });
    if (!items.length) { i = last + 1; continue; }
    const first = visible[0]!;
    const state = expansion(groupStates.get(first), hostExpanded);
    groupStates.set(first, state);
    const group = new Container();
    const padded = (width: number, draw: (available: number) => string[]) => {
      const pad = " ".repeat(Math.min(first.outputPad ?? 0, Math.floor(width / 2)));
      return draw(width - pad.length * 2).map(line => pad + line + pad);
    };
    group.addChild({
      render(width: number) {
        return ["", ...padded(width, available => style(`● ac-teams activity · ${activitySummary(items)}`, available, warnings))];
      },
      invalidate() {},
      handleMouse(event) {
        if (event.type !== "click" || event.button !== "left" || event.y === 0) return undefined;
        state.expanded = !state.expanded;
        requestRender();
        return { handled: true };
      },
    });
    if (state.expanded) items.forEach((item, index) => {
      const last = index === items.length - 1;
      const branch = last ? "└─ " : "├─ ";
      const continuation = last ? "   " : "│  ";
      const summary = item.category === "received message" || item.category === "sent message" || item.category === "message send" || item.category === "undelivered message" ? item.body[0]?.split("\n")[0] : undefined;
      const preview = item.preview ?? summary;
      group.addChild({
        render(width: number) {
          return padded(width, available => {
            const room = available - 5 - visibleWidth(item.title) - 3;
            const title = item.title + (preview && room > 4 ? ` · ${truncateToWidth(preview, room)}` : "");
            const lines = treeLines(title, available, `${branch}● `, continuation + "  ");
            if (item.state.expanded && item.details.some(text => text.trim())) {
              lines.push(...treeLines("", available, continuation + "  "));
              for (const text of item.details) lines.push(...treeLines(text, available, continuation + "  ").map(formatDetail));
              lines.push(...treeLines("", available, continuation + "  "));
            }
            return lines;
          });
        },
        invalidate() {},
        handleMouse(event) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          item.state.expanded = !item.state.expanded;
          requestRender();
          return { handled: true };
        },
      });
    });
    out.push(group);
    i = last + 1;
  }
  return out;
}

/** Pi has no row-grouping API; unexpected private layout shapes leave the transcript native. */
export function bindNoticeGroups(ctx: ExtensionContext, labels: () => Labels, self: () => string, ours: (line: string) => boolean) {
  if (ctx.mode !== "tui") return;
  let dispose: (() => void) | undefined;
  ctx.ui.setWidget(widget, tui => {
    dispose?.(); dispose = undefined;
    // SAFETY: Pi's private layout (document, then chat last); reject anything else.
    const chat = (tui as unknown as { children?: { children?: unknown[] }[] }).children?.[0]?.children?.at(-1) as Chat | undefined;
    if (chat && Array.isArray(chat.children) && typeof chat.render === "function" && !Object.hasOwn(chat, hook)) {
      const original = chat.render;
      const theme = ctx.ui.theme;
      const style = (header: string, width: number, warnings: string[]) => width <= 0 ? [""] : [
        ...wrapTextWithAnsi(theme.fg("accent", theme.bold(header)), width),
        ...warnings.flatMap(warning => wrapTextWithAnsi(theme.fg("warning", warning), width)),
      ];
      Object.defineProperty(chat, hook, { value: true, configurable: true });
      const render = function (this: Chat, width: number) {
        const children = this.children;
        this.children = groupTeamRows(children, width, style, labels(), self(), ours, () => tui.requestRender(), ctx.ui.getToolsExpanded(), line => styleRecordLine(line, theme));
        try { return original.call(this, width); } finally { this.children = children; }
      };
      chat.render = render;
      dispose = () => {
        if (chat.render !== render) return;
        chat.render = original;
        Reflect.deleteProperty(chat, hook);
      };
    }
    return { render: () => [], invalidate() {} };
  }, { placement: "belowEditor" });
  return () => { dispose?.(); dispose = undefined; };
}
