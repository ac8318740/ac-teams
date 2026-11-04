import { stripVTControlCharacters } from "node:util";
import { keyHint, type MessageRenderer, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export const cleanText = (text: string): string => stripVTControlCharacters(text).replaceAll("\t", " ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const inline = (value: unknown) => cleanText(String(value)).replace(/[\n\r\t]/g, " ");
const fieldName = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, c => c.toUpperCase());

function payloadLines(value: unknown, theme: Theme, width: number, indent = 2): string[] {
  const prefix = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
  if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((item, i) => [String(i + 1), item] as const) : Object.entries(value);
    if (!entries.length) return [prefix + (Array.isArray(value) ? "[]" : "{}")];
    return entries.flatMap(([key, item]) => {
      const label = `${fieldName(inline(key))}:`;
      const nested = item !== null && typeof item === "object";
      const multiline = typeof item === "string" && item.includes("\n");
      if (nested || multiline) return [
        ...wrapTextWithAnsi(theme.fg("muted", label), Math.max(1, width - prefix.length)).map(line => prefix + line),
        ...payloadLines(item, theme, width, indent + 2),
      ];
      return wrapTextWithAnsi(theme.fg("muted", label) + " " + cleanText(String(item)), Math.max(1, width - prefix.length)).map(line => prefix + line);
    });
  }
  return cleanText(String(value)).split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - prefix.length)).map(part => prefix + part));
}

function summary(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return ["action", "name", ...(typeof fields.name === "string" ? [] : ["id"]), "status", "title", "from", "through", "error", "text", "content"].filter(key => fields[key] !== undefined && typeof fields[key] !== "object")
      .map(key => `${fieldName(key)}: ${inline(fields[key])}`).join(" · ") || `${Object.keys(fields).length} field(s)`;
  }
  return inline(value);
}

function entry(title: string, value: unknown, expanded: boolean, theme: Theme, error = false, preview?: string): Component {
  return {
    render(width) {
      const lines = [truncateToWidth(theme.fg(error ? "error" : "accent", `${inline(title)} · ${preview === undefined ? summary(value) : inline(preview)}`), width)];
      if (expanded) lines.push("", ...payloadLines(value, theme, width));
      return lines.map(line => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}

type MemberLabels = () => Readonly<Record<string, string>>;
const defaultLabels: MemberLabels = () => ({ root: "Main" });
const memberLabel = (id: unknown, labels: Readonly<Record<string, string>>) => inline(typeof id === "string" && Object.hasOwn(labels, id) ? labels[id] : id);

function preview(items: unknown[], count: string, theme: Theme, labels: Readonly<Record<string, string>>): string {
  const entries = items.slice(0, 3).map(item => toolSummary(item, theme, labels)).filter(Boolean);
  if (items.length > 3) entries.push(`+${items.length - 3} more`);
  return [count, ...entries].join(" · ");
}

function toolSummary(data: unknown, theme: Theme, labels: Readonly<Record<string, string>>): string {
  if (Array.isArray(data)) return preview(data, `${data.length} messages`, theme, labels);
  if (data && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if (Array.isArray(value.members)) return preview(value.members, `${value.members.length} members`, theme, labels);
    if (Array.isArray(value.tasks)) return preview(value.tasks, value.total === undefined ? `${value.tasks.length} tasks` : `${value.tasks.length} of ${value.total} tasks`, theme, labels);
    const label = value.title ?? value.name ?? value.brief ?? value.summary ?? value.text ?? value.query ?? (Array.isArray(value.recipients) ? undefined : value.id === undefined ? undefined : memberLabel(value.id, labels));
    const status = value.status === undefined ? "" : inline(value.status);
    const color = status === "done" ? "success"
      : status === "interrupted" ? "error"
      : status === "busy" || status === "in_progress" ? "accent"
      : status === "todo" || status === "starting" || status === "stopping" ? "warning" : "muted";
    const parts = [status ? theme.fg(color, theme.bold(`[${status}]`)) : "", label === undefined ? "" : inline(label)];
    if (Array.isArray(value.recipients)) parts.push(`${value.from === undefined ? "to" : `${memberLabel(value.from, labels)} →`} ${value.recipients.map(id => memberLabel(id, labels)).join(", ")}`);
    for (const key of ["seq", "limit", "depth"]) {
      if (value[key] !== undefined) parts.push(`${key}: ${inline(value[key])}`);
    }
    return parts.filter(Boolean).join(" ");
  }
  return data === undefined || data === null ? "" : memberLabel(data, labels);
}

export function teamToolRenderers(name: string, getLabels: MemberLabels = defaultLabels): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      if (!context.isPartial) return new Container();
      const { action, ...fields } = (args ?? {}) as Record<string, unknown>;
      const request = toolSummary(fields, theme, getLabels());
      const text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", name)} · ${inline(action ?? "...")} → running${request ? ` · ${request}` : ""}`;
      return new TruncatedText(text, context.outputPad, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const { action, ...fields } = (context.args ?? {}) as Record<string, unknown>;
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      let data: unknown = result.details;
      if (data === undefined) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      const labels = getLabels();
      const waiting = action === "wait" && Array.isArray(data) && data.length === 0;
      const outcome = context.isError ? `error · ${inline(text)}` : waiting ? "turn ended; the next post wakes this session" : toolSummary(data, theme, labels) || "done";
      const request = toolSummary(fields, theme, labels);
      const heading = `${theme.fg(context.isError ? "error" : "success", "●")} ${theme.fg("toolTitle", name)} · ${inline(action ?? "...")} → ${outcome}${request && !outcome.includes(request) ? ` · ${request}` : ""}`;
      const responseJSON = cleanText(result.details === undefined ? text : JSON.stringify(result.details, null, 2));
      const hiddenLines = responseJSON.split("\n").length;
      const hint = theme.fg("muted", options.expanded ? " (" : ` … +${hiddenLines} lines (`)
        + keyHint("app.tools.expand", options.expanded ? "to collapse" : "to expand") + theme.fg("muted", ")");
      const row = new Container();
      row.addChild({
        invalidate() {},
        render(width) {
          const pad = " ".repeat(Math.min(context.outputPad, Math.floor(width / 2)));
          const available = Math.max(0, width - pad.length * 2);
          // Keep the hint visible unless the terminal is too narrow to also identify the tool.
          const suffix = available >= visibleWidth(hint) + 30 ? hint : "";
          return [pad + truncateToWidth(heading, available - visibleWidth(suffix)) + suffix + pad];
        },
      });
      if (options.expanded) {
        row.addChild(new Text(responseJSON, context.outputPad, 0));
      }
      return row;
    },
  };
}

export function teamMessageRenderer(getLabels: MemberLabels = defaultLabels): MessageRenderer {
  return (message, { expanded }, theme) => {
    const details = message.details as { through?: number; messages?: { from: string; summary: string; recipients: string[]; task?: string; kind?: string }[] } | undefined;
    const posts = details?.messages ?? [], recent = posts.at(-1);
    const more = posts.length > 1 ? ` (+${posts.length - 1} more)` : "";
    const labels = getLabels();
    const name = (id: string) => memberLabel(id, labels);
    // Lead with what happened: "count-a completed #1 Count lines · 37 lines", or "count-a → Main · #1 … · question".
    const what = recent && (recent.kind === "outcome" && recent.task ? `${name(recent.from)} completed ${name(recent.task)}` : `${name(recent.from)} → ${recent.recipients.map(name).join(", ")}${recent.task ? ` · ${name(recent.task)}` : ""}`);
    const preview = recent ? `${what} · ${recent.summary.split("\n")[0]}${more}` : `Updates through ${details?.through ?? "unknown"}`;
    return entry("ac-teams", details ?? { content: message.content }, expanded, theme, false, preview);
  };
}

export const renderTeamMessage = teamMessageRenderer();
