import { stripVTControlCharacters } from "node:util";
import type { MessageRenderer, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

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

export function teamToolRenderers(name: string): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      return entry(name, args, context.expanded, theme);
    },
    renderResult(result, options, theme, context) {
      let data: unknown = result.details;
      if (data === undefined) {
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        try { data = JSON.parse(text); } catch { data = text; }
      }
      return entry(`${name} ${options.isPartial ? "receiving" : "result"}`, data, options.expanded, theme, context.isError);
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
