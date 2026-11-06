import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, setKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { cleanText, renderTeamMessage, teamMessageRenderer, teamToolPresentation, teamToolRenderers, styleRecordLine } from "../src/ui/render.ts";

// SAFETY: these bounded Pi doubles implement only the documented methods the UI uses.
const theme = {
  fg(color: string, text: string) { return `\x1b[${color === "dim" ? 90 : color === "accent" ? 95 : 37}m${text}\x1b[39m`; },
  bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
  underline(text: string) { return `\x1b[4m${text}\x1b[24m`; },
  style(text: string, options: { fg: Parameters<typeof foregroundAnsi>[0] }) { return foregroundAnsi(options.fg, "256color") + text + "\x1b[39m"; },
} as unknown as Theme;

const renderContext = (expanded = false) => ({ expanded, isError: false, isPartial: false, args: { action: "send" }, outputPad: 0 }) as Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const plain = (component: Component, width = 60) => component.render(width).map(line => cleanText(line).trimEnd()).join("\n");

test("tool renderers use the running host's key hint without initializing a second Pi theme", () => {
  const context = { ...renderContext(true), keyHint: (key: string, description: string) => {
    assert.equal(key, "app.tools.expand");
    return `alt+q ${description}`;
  } };
  const row = teamToolRenderers("team_message").renderResult!({ content: [], details: { recipients: ["reviewer"] } }, { expanded: true, isPartial: false }, theme, context);
  const text = plain(row, 200);
  assert.match(text, /Message sent · Main agent \(this session\) → reviewer/);
  assert.match(text, /alt\+q to collapse details/);
  assert.match(text, /To: reviewer/);
  assert.doesNotMatch(text, /Technical details/);
});

test("record styles underline sections and emphasize labels without styling values", () => {
  for (const prefix of ["", "│    ", "     "]) {
    assert.equal(styleRecordLine(prefix + "Message 2 · Sent", theme), prefix + theme.fg("accent", theme.underline(theme.bold("Message 2 · Sent"))));
    assert.equal(styleRecordLine(prefix + "From: Reviewer", theme), prefix + theme.fg("accent", theme.bold("From:")) + " Reviewer");
    assert.equal(styleRecordLine(prefix + "Sent at: 2026-11-04", theme), prefix + theme.fg("accent", theme.bold("Sent at:")) + theme.fg("dim", " 2026-11-04"));
    assert.equal(styleRecordLine(prefix + "Summary: A colon: stays ordinary", theme), prefix + theme.fg("accent", theme.bold("Summary:")) + " A colon: stays ordinary");
    assert.equal(styleRecordLine(prefix + "Plain body\x1b[2J", theme), prefix + "Plain body");
  }
});

test("incoming records separate the next heading from the previous message", () => {
  const render = teamMessageRenderer(() => ({ root: "Main", m1: "Reviewer" }));
  const message = { role: "custom" as const, customType: "ac-teams", content: "", display: true, timestamp: 0, details: { messages: [
    { from: "m1", recipients: ["root"], summary: "First message" },
    { from: "m1", recipients: ["root"], summary: "Second message" },
  ] } };
  const text = plain(render(message, { expanded: true, outputPad: 0 }, theme)!, 300);
  assert.match(text, /Summary: First message\n\nMessage received/);
  assert.match(text, /Message received[^\n]*\n\nFrom:/, "incoming-message details follow the same one-blank-line rule as every expanded action");
});

test("wait results do not turn the current agent's outgoing task posts into received messages", () => {
  const sent = { from: "root", recipients: ["reviewer"], summary: "Please review the parser" };
  const received = { from: "reviewer", recipients: ["root"], summary: "Review complete" };
  const ownWait = teamToolPresentation("team_message", { action: "wait" }, { details: [sent] }, { root: "Main" });
  assert.equal(ownWait.title, "Agent paused · Notifications active");
  assert.deepEqual(ownWait.body, ["Existing task notifications remain active. A new addressed post will resume the agent."]);
  const mixedWait = teamToolPresentation("team_message", { action: "wait" }, { details: [sent, received] }, { root: "Main" });
  assert.equal(mixedWait.title, "1 update available · Continuing");
  assert.deepEqual(mixedWait.body, ["Message received · reviewer → Main agent (this session)", "Review complete"]);
  const history = teamToolPresentation("team_message", { action: "history" }, { details: [sent, received] }, { root: "Main" });
  assert.match(history.body[0]!, /^Message sent · Main agent \(this session\) → reviewer$/);
  assert.match(history.body[2]!, /^Message received · reviewer → Main agent \(this session\)$/);
});

test("tool renderers expand readable records without mutating payloads or exposing terminal controls", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const renderers = teamToolRenderers("team_message");
  const data = { id: "M1", text: "First line\nA long second line that must wrap instead of becoming a JSON dump.\x1b[2J", recipients: ["root"] };
  const result = { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
  const before = JSON.stringify(result);
  const compact = plain(renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext()));
  assert.ok(!compact.includes("Recipients:"));
  const expanded = renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, renderContext(true));
  const lines = expanded.render(32);
  assert.ok(lines.every(line => visibleWidth(line) <= 32));
  const text = plain(expanded, 2000);
  assert.match(text, /Summary:\n\s+First line\n\s+A long second line that must wrap instead of becoming a JSON dump\./);
  assert.match(text, /To: Main agent \(this session\) \[root\]/);
  assert.doesNotMatch(text, /Request|Response|Technical details|"recipients"/);
  assert.ok(!text.includes("\x1b[2J"));
  assert.equal(JSON.stringify(result), before);
  const fallback = renderers.renderResult!({ content: result.content, details: undefined }, { expanded: true, isPartial: false }, theme, renderContext(true));
  assert.equal(plain(fallback, 2000), text, "text-only JSON results use the same readable fields");
  assert.equal(plain(renderers.renderCall!({ action: "send", summary: data.text }, theme, renderContext(true))), "");
  const agentData = { id: "member-uuid", name: "parser-review", status: "idle" };
  const agentResult = { content: [{ type: "text" as const, text: JSON.stringify(agentData) }], details: agentData };
  const agentRenderers = teamToolRenderers("team_agent");
  const agentContext = { ...renderContext(), args: { action: "status" } };
  assert.match(plain(agentRenderers.renderResult!(agentResult, { expanded: false, isPartial: false }, theme, agentContext), 200), /parser-review · Ready/);
  assert.ok(!plain(agentRenderers.renderResult!(agentResult, { expanded: false, isPartial: false }, theme, agentContext)).includes("member-uuid"));
  assert.match(plain(agentRenderers.renderResult!(agentResult, { expanded: true, isPartial: false }, theme, agentContext)), /Agent: parser-review \[member-uuid\]/);
  const message = renderTeamMessage({ role: "custom", customType: "team", content: "hello\x1b]0;bad\x07", display: true, timestamp: 0 }, { expanded: true, outputPad: 0 }, theme)!;
  assert.match(plain(message), /hello/);
  assert.equal(cleanText("x\x1b]0;title\x07\x1b[31my\x00\r\nz"), "xy\nz");
});

test("expanded records retain requested instructions, full errors and unknown agent identities", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const renderer = teamToolRenderers("team_agent");
  const context = { ...renderContext(true), args: { action: "launch", name: "Reviewer", brief: "Check cancellation\nCheck cleanup" } };
  const text = plain(renderer.renderResult!({ content: [], details: { id: "new-agent", status: "busy" } }, { expanded: true, isPartial: false }, theme, context), 300);
  assert.match(text, /Brief:\n\s+Check cancellation\n\s+Check cleanup/);
  assert.match(text, /Id: new-agent/);
  assert.match(text, /Status: Working/);
  assert.doesNotMatch(text, /Technical details|Action:|"brief"/);
  const failed = plain(renderer.renderResult!({ content: [{ type: "text", text: "Connection failed\nTry again\x1b[2J" }], details: undefined }, { expanded: true, isPartial: false }, theme, { ...context, isError: true }), 300);
  assert.match(failed, /Agent launch failed/);
  assert.match(failed, /Error:\n\s+Connection failed\n\s+Try again/);
  assert.doesNotMatch(failed, /\x1b/);
});

test("compact tool rows prefer aliases while expanded records identify agents", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const labels = () => ({ root: "Main", "member-uuid": "oom-review" });
  for (const [tool, args, data, expected] of [
    ["team_message", { action: "send", recipients: ["member-uuid"], text: "Review" }, { id: "message-uuid", seq: 7, recipients: ["member-uuid"] }, /Message sent · Main agent \(this session\) → oom-review/],
    ["team_agent", { action: "status", id: "member-uuid" }, { id: "member-uuid", name: "oom-review", status: "idle" }, /oom-review · Ready/],
    ["team_message", { action: "history" }, [{ id: "message-uuid", from: "member-uuid", recipients: ["root"], text: "Done" }], /oom-review → Main agent/],
  ] as const) {
    const renderers = teamToolRenderers(tool, labels);
    const context = { ...renderContext(), args };
    const result = { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
    const compact = plain(renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, context), 1000);
    assert.match(compact, expected);
    assert.doesNotMatch(compact, /member-uuid|message-uuid/);
    const expanded = plain(renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, context), 2000);
    assert.match(expanded, /oom-review \[member-uuid\]/);
    assert.doesNotMatch(expanded, /message-uuid|Technical details|"from"/);
    if (tool === "team_message" && args.action === "history") assert.match(expanded, /Summary: Done/);
    const pending = plain(renderers.renderCall!(args, theme, { ...context, isPartial: true }), 1000);
    assert.doesNotMatch(pending, /member-uuid/);
  }
});

test("message delivery and team rosters explain events without tool mechanics", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const labels = () => ({ root: "Main", worker: "Reviewer" });
  const render = (tool: string, args: object, data: unknown, expanded = false, self = "root") => {
    const renderer = teamToolRenderers(tool, labels, () => self);
    return plain(renderer.renderResult!({ content: [{ type: "text", text: JSON.stringify(data) }], details: data },
      { expanded, isPartial: false }, theme, { ...renderContext(), args }), 2000);
  };
  const args = { action: "send", recipients: ["worker"], summary: "Review the parser", detail: "Check cancellation" };
  const sent = render("team_message", args, { recipients: ["worker"], seq: 7 });
  assert.match(sent, /Message sent · Main agent \(this session\) → Reviewer/);
  assert.match(sent, /Review the parser/);
  assert.doesNotMatch(sent, /team_message|seq:|\+\d+ lines|Receipt/);
  assert.match(render("team_message", { ...args, recipients: ["root"] }, { recipients: [], seq: 8 }), /Message not delivered · No recipients/);
  const undelivered = { from: "root", recipients: [], summary: "No audience" };
  for (const expanded of [false, true]) {
    const history = render("team_message", { action: "history" }, [undelivered], expanded);
    assert.match(history, expanded ? /Message 1 · Not delivered/ : /Message not delivered.*No recipients/);
    assert.doesNotMatch(history, /Message sent|Message 1 · Sent/);
  }
  const notice = teamMessageRenderer(labels)({ role: "custom", customType: "ac-teams", content: "", display: true, timestamp: 0, details: { messages: [undelivered] } }, { expanded: false, outputPad: 0 }, theme)!;
  assert.match(plain(notice, 2000), /Message not delivered.*No recipients/);
  assert.match(render("team_message", args, { recipients: ["root"] }, false, "worker"), /Reviewer \(this session\) → Main agent/);
  const roster = render("team_agent", { action: "list" }, { members: [
    { id: "root", name: "Main", status: "busy", depth: 0 },
    { id: "worker", name: "Reviewer", status: "interrupted", depth: 1, error: "Child exited before readiness" },
  ] });
  assert.match(roster, /Checked team status · 2 agents/);
  assert.match(roster, /Main agent \(this session\).*Working/);
  assert.match(roster, /Reviewer.*Failed to start/);
  assert.doesNotMatch(roster, /team_agent|depth|interrupted|\+\d+ lines/);
  const expanded = render("team_message", args, { recipients: ["worker"], seq: 7 }, true);
  assert.match(expanded, /Summary: Review the parser\nMessage: Check cancellation/);
  assert.equal((expanded.match(/Check cancellation/g) ?? []).length, 1);
  assert.doesNotMatch(expanded, /Technical details|"seq"/);
});

test("outgoing message rows state direction before the message and preserve it on expansion", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const renderers = teamToolRenderers("team_message", () => ({ m1: "count-a" }));
  const args = { action: "send", recipients: ["m1"], summary: "Review the parser", detail: "Full instructions" };
  const context = { ...renderContext(), args };
  const data = { from: "root", recipients: ["m1"], seq: 7, summary: args.summary };
  const result = { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
  assert.match(plain(renderers.renderCall!(args, theme, { ...context, isPartial: true }), 200), /Sending message · Main agent \(this session\) → count-a/);
  for (const expanded of [false, true]) {
    const rendered = plain(renderers.renderResult!(result, { expanded, isPartial: false }, theme, context), 1000);
    assert.match(rendered, /Message sent · Main agent \(this session\) → count-a[\s\S]*Review the parser/);
    assert.doesNotMatch(rendered.split("\n")[0]!, /root →/);
    if (expanded) {
      assert.match(rendered, /Message: Full instructions/);
      assert.match(rendered, /To: count-a \[m1\]/);
      assert.equal((rendered.match(/Review the parser/g) ?? []).length, 1);
      assert.doesNotMatch(rendered, /Technical details/);
    }
    const error = plain(renderers.renderResult!(result, { expanded, isPartial: false }, theme, { ...context, isError: true }), 1000);
    assert.match(error, /Message could not be sent/);
    assert.doesNotMatch(error, /Message sent/);
  }
});

test("notification previews use aliases and fall back to unknown IDs", () => {
  const render = teamMessageRenderer(() => ({ root: "Main", "member-uuid": "oom-review\x1b[2J" }));
  const message = { role: "custom" as const, customType: "ac-teams", content: "Notice", display: true, timestamp: 0,
    details: { through: 3, messages: [{ from: "member-uuid", recipients: ["root", "legacy-id"], summary: "Done\nDetails" }] } };
  const compact = plain(render(message, { expanded: false, outputPad: 0 }, theme)!, 1000);
  assert.match(compact, /Message received · oom-review → Main agent \(this session\), legacy-id\nDone/);
  assert.doesNotMatch(compact, /member-uuid|Details/);
  assert.ok(!compact.includes("\x1b"));
  const expanded = plain(render(message, { expanded: true, outputPad: 0 }, theme)!, 1000);
  assert.match(expanded, /Message received · oom-review/);
  assert.match(expanded, /member-uuid/);
});

test("an outcome notice says who completed which task, by name", () => {
  const render = teamMessageRenderer(() => ({ root: "Main", m1: "count-a", t1: "#1 Count lines" }));
  const posts = [{ from: "m1", recipients: ["root"], summary: "Started", task: "t1" }, { from: "m1", recipients: ["root"], summary: "37 lines\nmore", task: "t1", kind: "outcome" }];
  const compact = plain(render({ role: "custom" as const, customType: "ac-teams", content: "", display: true, timestamp: 0, details: { through: 2, messages: posts } }, { expanded: false, outputPad: 0 }, theme)!, 200);
  assert.equal(compact, "Message received · count-a → Main agent (this session) · #1 Count lines\nStarted\n\nMessage received · count-a → Main agent (this session) · Task completed · #1 Count lines\n37 lines");
});
