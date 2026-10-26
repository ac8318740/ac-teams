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

function preview(items: unknown[], count: string, theme: Theme): string {
  const entries = items.slice(0, 3).map(item => toolSummary(item, theme)).filter(Boolean);
  if (items.length > 3) entries.push(`+${items.length - 3} more`);
  return [count, ...entries].join(" · ");
}

function toolSummary(data: unknown, theme: Theme): string {
  if (Array.isArray(data)) return preview(data, `${data.length} messages`, theme);
  if (data && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if (Array.isArray(value.members)) return preview(value.members, `${value.members.length} members`, theme);
    if (Array.isArray(value.tasks)) return preview(value.tasks, `${value.tasks.length} of ${value.total} tasks`, theme);
    const label = value.title ?? value.name ?? value.brief ?? value.text ?? value.query ?? value.id;
    const status = value.status === undefined ? "" : inline(value.status);
    const color = status === "done" ? "success"
      : status === "interrupted" ? "error"
      : status === "busy" || status === "in_progress" ? "accent"
      : status === "todo" || status === "starting" || status === "stopping" ? "warning" : "muted";
    const parts = [status ? theme.fg(color, theme.bold(`[${status}]`)) : "", label === undefined ? "" : inline(label)];
    if (Array.isArray(value.recipients)) parts.push(`to ${value.recipients.map(inline).join(", ")}`);
    for (const key of ["seq", "limit", "depth"]) {
      if (value[key] !== undefined) parts.push(`${key}: ${inline(value[key])}`);
    }
    return parts.filter(Boolean).join(" ");
  }
  return data === undefined || data === null ? "" : inline(data);
}

export function teamToolRenderers(name: string): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      if (!context.isPartial) return new Container();
      const { action, ...fields } = (args ?? {}) as Record<string, unknown>;
      const request = toolSummary(fields, theme);
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
      const outcome = context.isError ? `error · ${inline(text)}` : toolSummary(data, theme) || "done";
      const request = toolSummary(fields, theme);
      const heading = `${theme.fg(context.isError ? "error" : "success", "●")} ${theme.fg("toolTitle", name)} · ${inline(action ?? "...")} → ${outcome}${request && !outcome.includes(request) ? ` · ${request}` : ""}`;
      const requestJSON = cleanText(JSON.stringify(context.args, null, 2));
      const responseJSON = cleanText(result.details === undefined ? text : JSON.stringify(result.details, null, 2));
      const hiddenLines = requestJSON.split("\n").length + responseJSON.split("\n").length + 2;
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
        row.addChild(new Text(theme.fg("muted", "Request"), context.outputPad, 0));
        row.addChild(new Text(requestJSON, context.outputPad, 0));
        row.addChild(new Text(theme.fg("muted", "Response"), context.outputPad, 0));
        row.addChild(new Text(responseJSON, context.outputPad, 0));
      }
      return row;
    },
  };
}

export const renderTeamMessage: MessageRenderer = (message, { expanded }, theme) => {
  const details = message.details as { through?: number; messages?: { from: string; text: string; recipients: string[] }[] } | undefined;
  const recent = details?.messages?.at(-1);
  const name = (id: string) => id === "root" ? "Main" : id;
  const preview = recent ? `${name(recent.from)} → ${recent.recipients.map(name).join(", ")} · ${recent.text.split("\n")[0]}` : `Updates through ${details?.through ?? "unknown"}`;
  return entry("Team message", details ?? { content: message.content }, expanded, theme, false, preview);
};
