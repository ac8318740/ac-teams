import { stripVTControlCharacters } from "node:util";
import { keyHint, type MessageRenderer, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const cleanText = (text: string): string => stripVTControlCharacters(text).replaceAll("\t", " ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const inline = (value: unknown) => cleanText(String(value ?? "")).replace(/[\n\r\t]/g, " ");
const fieldName = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
type MemberLabels = () => Readonly<Record<string, string>>;
const defaultLabels: MemberLabels = () => ({ root: "Main" });
type Result = { details?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
type Presentation = { title: string; body: string[]; category: string; activity?: string; preview?: string; problem?: boolean };

export function styleRecordLine(line: string, theme: Theme): string {
  const text = cleanText(line);
  const heading = /^([│ ]*)(Message \d+ · (?:Sent|Received|Not delivered))$/.exec(text);
  if (heading) return heading[1] + theme.fg("accent", theme.underline(theme.bold(heading[2]!)));
  const field = /^([│ ]*)([A-Z][A-Za-z0-9 ]*:)(.*)$/.exec(text);
  if (!field) return text;
  return field[1] + theme.fg("accent", theme.bold(field[2]!)) + (field[2] === "Sent at:" ? theme.fg("dim", field[3]!) : field[3]);
}

function readableFields(value: unknown, labels: Readonly<Record<string, string>>, self: string, indent = ""): string[] {
  if (!value || typeof value !== "object") return cleanText(String(value ?? "")).split("\n").map(line => indent + line);
  const entries = Array.isArray(value) ? value.map((item, i) => [String(i + 1), item] as const) : Object.entries(value);
  return entries.flatMap(([key, raw]) => {
    if (raw === undefined || raw === null) return [];
    const item = key === "status" ? state(object(value)) : key === "from" || key === "owner" ? identity(raw, labels, self)
      : key === "recipients" && Array.isArray(raw) ? raw.map(id => identity(id, labels, self)).join(", ") || "None (not delivered)"
      : typeof raw === "string" && labels[raw] ? identity(raw, labels, self) : raw;
    const label = `${indent}${fieldName(inline(key))}:`;
    return typeof item === "object" || String(item).includes("\n")
      ? [label, ...readableFields(item, labels, self, indent + "  ")]
      : [`${label} ${cleanText(String(item))}`];
  });
}

type ToolData = Record<string, unknown> | unknown[] | string | undefined;
function resultData(result: Result | undefined): ToolData {
  let data = result?.details;
  if (data === undefined) {
    const text = result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
    try { data = JSON.parse(text ?? ""); } catch { data = text; }
  }
  return data == null ? undefined : typeof data === "object" ? data as Record<string, unknown> | unknown[] : String(data);
}

function agentName(id: unknown, labels: Readonly<Record<string, string>>, self: string): string {
  const label = inline(labels[String(id)] ?? id ?? "Unknown agent");
  const name = label === "Main" || id === "root" ? "Main agent" : label;
  return String(id) === self ? `${name} (this session)` : name;
}

function state(value: Record<string, unknown>): string {
  if (value.status === "interrupted") return String(value.error ?? "").includes("before readiness") ? "Failed to start" : "Stopped unexpectedly";
  return ({ busy: "Working", idle: "Ready", starting: "Starting", stopping: "Stopping", stopped: "Stopped", done: "Completed", todo: "Not started", in_progress: "In progress" } as Record<string, string>)[String(value.status)] ?? fieldName(inline(value.status));
}

function identity(id: unknown, labels: Readonly<Record<string, string>>, self: string): string {
  const name = agentName(id, labels, self);
  return id != null && (labels[String(id)] || id === "root") ? `${name} [${inline(id)}]` : name;
}

export function messageDetails(post: unknown, labels: Readonly<Record<string, string>>, self = "root"): string[] {
  const value = object(post);
  return readableFields({
    From: identity(value.from, labels, self),
    To: Array.isArray(value.recipients) ? value.recipients.map(id => identity(id, labels, self)).join(", ") || "None (not delivered)" : identity(self, labels, self),
    Task: value.task ? labels[String(value.task)] ?? value.task : undefined,
    Result: value.kind === "outcome" ? "Task completed" : undefined,
    Summary: value.summary ?? value.text,
    Message: value.detail,
    "Sent at": value.time,
  }, {}, self);
}

export function teamToolDetails(tool: string, args: unknown, result: Result | undefined, labels: Readonly<Record<string, string>>, self = "root"): string[] {
  const fields = object(args), data = resultData(result), value = object(data), action = String(fields.action ?? "");
  if (tool === "team_message" && action === "send") {
    const lines = messageDetails({ ...fields, ...value, from: self, summary: fields.summary ?? fields.text ?? value.summary ?? value.text, detail: fields.detail ?? value.detail }, labels, self);
    if (result?.isError) lines.push(...readableFields({ Error: typeof data === "string" ? data : data ?? "Message could not be sent" }, labels, self));
    return lines;
  }
  if (result?.isError) return readableFields({ Error: data }, labels, self);
  if (tool === "team_message" && ["history", "search", "wait"].includes(action)) {
    const posts = Array.isArray(data) ? data.filter(post => action !== "wait" || object(post).from !== self) : [];
    return posts.length ? posts.flatMap((post, index) => [
      ...(index ? [""] : []), `Message ${index + 1} · ${messagePresentation(post, labels, self).category === "undelivered message" ? "Not delivered" : object(post).from === self ? "Sent" : "Received"}`,
      ...messageDetails(post, labels, self),
    ]) : [result ? action === "wait" ? "Agent paused. Notifications remain active; a new addressed post will resume it." : "No matching messages." : "Waiting for results..."];
  }
  if (tool === "team_agent" && ["list", "status"].includes(action)) {
    const members = Array.isArray(value.members) ? value.members : value.id ? [value] : [];
    return members.length ? members.flatMap((member, index) => {
      const item = object(member), id = String(item.id ?? item.name);
      return [...(index ? [""] : []), ...readableFields({
        Agent: identity(id, { ...labels, [id]: String(labels[id] ?? item.name ?? id) }, self),
        Status: state(item), Directory: item.cwd, Model: item.model, Error: item.error,
      }, {}, self)];
    }) : [result ? "No agents found." : "Checking team status..."];
  }
  const details = data && typeof data === "object" && !Array.isArray(data) ? { ...fields, ...data, action: undefined } : data ?? { ...fields, action: undefined };
  return readableFields(details, labels, self);
}

export function messagePresentation(post: unknown, labels: Readonly<Record<string, string>>, self = "root"): Presentation {
  const value = object(post);
  const recipients = Array.isArray(value.recipients) ? value.recipients : [self];
  const route = `${agentName(value.from, labels, self)} → ${recipients.map(id => agentName(id, labels, self)).join(", ") || "No recipients"}`;
  const task = value.task ? ` · ${inline(labels[String(value.task)] ?? value.task)}` : "";
  const completed = value.kind === "outcome" ? " · Task completed" : "";
  const outgoing = value.from === self;
  return { title: `Message ${!recipients.length ? "not delivered" : outgoing ? "sent" : "received"} · ${route}${completed}${task}`, body: [value.summary ?? value.text, value.detail].filter(value => typeof value === "string").map(value => cleanText(String(value))), category: !recipients.length ? "undelivered message" : outgoing ? "sent message" : "received message", problem: !recipients.length };
}

/** One presentation for native rows and folded previews, so direction and outcomes cannot disagree. */
export function teamToolPresentation(tool: string, args: unknown, result: Result | undefined, labels: Readonly<Record<string, string>>, self = "root"): Presentation {
  const fields = object(args), action = String(fields.action ?? "");
  const text = result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n") ?? "";
  const data = resultData(result);
  const value = object(data), pending = !result;
  const failed = !!result?.isError;
  const target = inline(fields.name ?? labels[String(fields.id)] ?? fields.id);
  if (failed && !(tool === "team_message" && action === "send")) {
    return { title: `${fieldName(tool.replace("team_", ""))} ${action || "operation"} failed`, body: [cleanText(text)], category: `failed ${tool.replace("team_", "")} ${action || "operation"}`, problem: true };
  }
  if (tool === "team_message" && action === "send") {
    const recipients = Array.isArray(value.recipients) ? value.recipients : fields.recipients;
    const body = [fields.summary ?? fields.text, fields.detail].filter(value => typeof value === "string").map(value => cleanText(String(value)));
    if (failed) return { title: "Message could not be sent", body: [...body, cleanText(text)], category: "failed message send", problem: true };
    if (!pending && Array.isArray(recipients) && !recipients.length) return { title: "Message not delivered · No recipients", body: [...body, "No other agents were included in the message recipients."], category: "undelivered message", problem: true };
    const destination = Array.isArray(recipients) && recipients.length ? recipients.map(id => agentName(id, labels, self)).join(", ") : fields.task ? `agents linked to ${inline(labels[String(fields.task)] ?? fields.task)}` : "linked recipients";
    return { title: `${pending ? "Sending message" : "Message sent"} · ${agentName(self, labels, self)} → ${destination}`, body, category: pending ? "message send" : "sent message" };
  }
  if (tool === "team_message" && (action === "watch" || action === "unwatch")) {
    const watches = Array.isArray(value.watching) ? value.watching : [];
    const updates = Array.isArray(value.updates) ? value.updates : [];
    const body = watches.map(watch => { const item = object(watch); return `${inline(labels[String(item.task)] ?? item.task)}: ${item.seq ? "triggered; delivery pending" : item.event === "completed" ? "notify on completion" : "notify on next message"}`; });
    for (const post of updates) { const item = messagePresentation(post, labels, self); body.push(item.title, ...item.body); }
    return { title: pending ? action === "watch" ? "Setting task notifications" : "Cancelling task notifications" : `Task notifications · ${watches.length} active${updates.length ? ` · ${updates.length} updates available` : ""}`, body, category: "task notifications", activity: action === "watch" ? "Set task notifications" : "Cancelled task notifications", problem: failed };
  }
  if (tool === "team_message" && action === "wait") {
    const posts = Array.isArray(data) ? data.filter(post => object(post).from !== self) : [];
    const body = posts.flatMap(post => { const item = messagePresentation(post, labels, self); return [item.title, ...item.body]; });
    if (Array.isArray(fields.tasks) && fields.tasks.length) body.push(`Next-message notifications: ${fields.tasks.map(task => inline(labels[String(task)] ?? task)).join(", ")}`);
    if (!pending && !posts.length) body.push("Existing task notifications remain active. A new addressed post will resume the agent.");
    return { title: pending ? "Pausing agent" : posts.length ? `${posts.length} update${posts.length === 1 ? "" : "s"} available · Continuing` : "Agent paused · Notifications active", body, category: "pause agent", activity: pending ? "Pausing agent" : posts.length ? "Received updates" : "Paused for updates", problem: failed };
  }
  if (tool === "team_message" && (action === "history" || action === "search")) {
    const posts = Array.isArray(data) ? data : [];
    const participants = [...new Set(posts.flatMap(post => { const item = object(post); return [item.from, ...(Array.isArray(item.recipients) ? item.recipients : [])].filter(id => id != null).map(id => agentName(id, labels, self)); }))];
    const latest = object(posts.at(-1));
    const preview = [...(participants.length ? [participants.join(" ↔ ")] : []), ...(latest.summary || latest.text ? [`Latest: ${inline(latest.summary ?? latest.text)}`] : [])].join(" · ");
    return { preview, title: pending ? "Looking up messages" : `${action === "history" ? "Message history" : "Message search"} · ${posts.length} message${posts.length === 1 ? "" : "s"}`, body: posts.flatMap(post => { const item = messagePresentation(post, labels, self); return [item.title, ...item.body]; }), category: action === "history" ? "message history check" : "message search", activity: pending ? "Looking up messages" : `${action === "history" ? "Looked up" : "Searched messages; found"} ${posts.length} message${posts.length === 1 ? "" : "s"}`, problem: failed };
  }
  if (tool === "team_agent" && (action === "list" || action === "status")) {
    const members = Array.isArray(value.members) ? value.members : value.id ? [value] : [];
    const preview = members.map(member => {
      const item = object(member), id = String(item.id ?? item.name);
      return `${agentName(id, { ...labels, [id]: String(labels[id] ?? item.name ?? id) }, self)}: ${state(item)}`;
    }).join("; ");
    return { preview, title: `${pending ? "Checking" : "Checked"} team status${pending ? "" : ` · ${members.length} agent${members.length === 1 ? "" : "s"}`}`, body: members.map(member => {
      const item = object(member), id = String(item.id ?? item.name);
      const names = { ...labels, [id]: String(labels[id] ?? item.name ?? id) };
      return `${agentName(id, names, self)} · ${state(item)}`;
    }), category: "status check", problem: failed };
  }
  if (tool === "team_agent" && (action === "launch" || action === "resume")) {
    const interrupted = value.status === "interrupted";
    const problem = failed || interrupted;
    const title = problem ? "Teammate failed to start" : pending ? "Starting teammate" : "Teammate started";
    return { title: `${title} · ${inline(value.name ?? target)}`, body: value.error ? [cleanText(String(value.error))] : [], category: `${problem ? "failed " : ""}teammate ${action === "launch" ? "launch" : "resume"}`, problem };
  }
  if (tool === "team_task") {
    const tasks = Array.isArray(value.tasks) ? value.tasks : value.title || value.id ? [value] : [];
    const titles: Record<string, string> = { list: "Task list", read: "Task details", create: "Tasks created", start: "Task started", complete: "Task completed", edit: "Task updated", claim: "Task reserved", release: "Task released", reopen: "Task reopened" };
    const categories: Record<string, string> = { list: "task list", read: "task check", create: "task creation", start: "task start", complete: "task completion", edit: "task update", claim: "task reservation", release: "task release", reopen: "task reopen" };
    const pendingTitles: Record<string, string> = { list: "Listing tasks", read: "Reading task", create: "Creating tasks", start: "Starting task", complete: "Completing task", edit: "Updating task", claim: "Reserving task", release: "Releasing task", reopen: "Reopening task" };
    const count = action === "list" && !pending ? ` · ${tasks.length} of ${value.total ?? tasks.length} tasks` : "";
    return { title: `${pending ? pendingTitles[action] ?? "Updating task" : titles[action] ?? "Task activity"}${count}`, preview: tasks.map(task => inline(object(task).title)).filter(Boolean).join("; "), body: tasks.map(task => { const item = object(task); return `${inline(item.title ?? item.label ?? labels[String(item.id)] ?? item.id)} · ${state(item)}`; }), category: categories[action] ?? "task operation", problem: failed };
  }
  const titles: Record<string, string> = { stop: pending ? "Stopping teammate" : "Stopped teammate", cleanup: "Clean up stopped worktrees", limits: "Team limits" };
  return { title: `${titles[action] ?? fieldName(action || "Team activity")}${target ? ` · ${target}` : ""}${pending ? " · In progress" : ""}`, body: failed ? [cleanText(text)] : [], category: action === "limits" ? "limits check" : `${action || "team"} operation`, problem: failed };
}

export function teamToolRenderers(name: string, getLabels: MemberLabels = defaultLabels, getSelf: () => string = () => "root"): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      if (!context.isPartial) return new Container();
      const item = teamToolPresentation(name, args, undefined, getLabels(), getSelf());
      return new Text(theme.fg("warning", item.title), context.outputPad, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const item = teamToolPresentation(name, context.args, { ...result, isError: context.isError }, getLabels(), getSelf());
      const heading = theme.fg(item.problem ? "error" : "toolTitle", item.title);
      const hostKeyHint = (context as typeof context & { keyHint?: typeof keyHint }).keyHint ?? keyHint;
      const hint = theme.fg("muted", " (") + hostKeyHint("app.tools.expand", options.expanded ? "to collapse details" : "for details") + theme.fg("muted", ")");
      const row = new Container();
      row.addChild({
        invalidate() {},
        render(width) {
          const pad = " ".repeat(Math.min(context.outputPad, Math.floor(width / 2)));
          const available = Math.max(0, width - pad.length * 2);
          const suffix = available >= visibleWidth(hint) + 30 ? hint : "";
          return [pad + truncateToWidth(heading, available - visibleWidth(suffix)) + suffix + pad];
        },
      });
      const body = options.expanded ? teamToolDetails(name, context.args, { ...result, isError: context.isError }, getLabels(), getSelf()) : item.body.map(line => line.split("\n")[0]!);
      if (options.expanded && body.some(line => line.trim())) row.addChild(new Spacer(1));
      row.addChild(new Text((options.expanded ? body.map(line => styleRecordLine(line, theme)) : body).join("\n"), context.outputPad, 0));
      if (options.expanded && body.some(line => line.trim())) row.addChild(new Spacer(1));
      return row;
    },
  };
}

export function teamMessageRenderer(getLabels: MemberLabels = defaultLabels, getSelf: () => string = () => "root"): MessageRenderer {
  return (message, { expanded, outputPad }, theme) => {
    const details = object(message.details), posts = Array.isArray(details.messages) ? details.messages : [];
    const box = new Box(outputPad, 0);
    for (const post of posts) {
      const item = messagePresentation(post, getLabels(), getSelf());
      if (!expanded && box.children.length) box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("accent", expanded ? theme.underline(theme.bold(item.title)) : item.title), 0, 0));
      const body = expanded ? messageDetails(post, getLabels(), getSelf()) : item.body.map(line => line.split("\n")[0]!);
      if (expanded && body.some(line => line.trim())) box.addChild(new Spacer(1));
      box.addChild(new Text((expanded ? body.map(line => styleRecordLine(line, theme)) : body).join("\n"), 0, 0));
      if (expanded && body.some(line => line.trim())) box.addChild(new Spacer(1));
    }
    if (!posts.length) box.addChild(new Text(`Team update\n${cleanText(String(message.content))}`, 0, 0));
    return box;
  };
}

export const renderTeamMessage = teamMessageRenderer();
