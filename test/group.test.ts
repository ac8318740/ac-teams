import test from "node:test";
import assert from "node:assert/strict";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { groupTeamRows } from "../src/group.ts";
import { teamMessageRenderer, teamToolRenderers } from "../src/render.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const labels = { root: "Main", m1: "Reviewer" };
const notice = (messages: object[]) => ({ message: { customType: "ac-teams", details: { messages } }, render: () => ["notice"] });
const tool = (toolName: string, args: object, details?: unknown) => ({ toolName, args, ...(details === undefined ? {} : { result: { details } }), render: () => [toolName] });
const other = (text: string) => ({ render: () => [text] });
function view(children: unknown[], width = 160) {
  const chat = new Container();
  let expanded = false, renders = 0;
  const draw = () => {
    chat.children = groupTeamRows(children, width, (header, width, warnings) => [truncateToWidth(header, width), ...warnings], labels, "Main", line => line.startsWith("Warning: Host"), () => { renders++; }, expanded) as Container["children"];
    return chat.render(width);
  };
  const click = (text: string, type: "click" | "wheel" = "click", button: "left" | "right" = "left") => {
    const lines = draw(), y = lines.findIndex(line => line.includes(text));
    assert.ok(y >= 0, `visible row: ${text}`);
    return chat.handleMouse({ type, button, x: 1, y, width, height: lines.length, screenX: 1, screenY: y, shift: false, alt: false, ctrl: false });
  };
  return { draw, click, expand(value: boolean) { expanded = value; }, renders: () => renders };
}

test("three levels: descriptive summary, every action, independently expanded records", () => {
  const rows = [
    notice([{ from: "m1", recipients: ["root"], summary: "Review finished", detail: "First finding\nSecond finding" }]),
    tool("team_agent", { action: "status" }, { members: [{ id: "root", status: "busy" }, { id: "m1", status: "idle" }] }),
    tool("team_message", { action: "wait" }, []),
    tool("team_agent", { action: "stop", id: "m1" }, { id: "m1", status: "stopped" }),
  ];
  const ui = view(rows);
  const folded = ui.draw();
  assert.deepEqual(folded.filter(Boolean), ["● ac-teams activity · Received 1 message; checked team status; paused for updates; stopped teammate"]);
  assert.equal(ui.click("ac-teams activity", "wheel"), undefined);
  assert.equal(ui.click("ac-teams activity", "click", "right"), undefined);
  assert.deepEqual(ui.draw(), folded);
  assert.equal(ui.click("ac-teams activity")?.handled, true);
  const open = ui.draw();
  assert.equal(open.filter(line => /[├└]─ ●/.test(line)).length, 4, "all actions, including read-only and wait, are visible");
  assert.match(open.join("\n"), /Message received.*Reviewer.*Main agent.*Review finished/);
  assert.match(open.join("\n"), /Checked team status.*Main agent.*Working.*Reviewer.*Ready/);
  assert.match(open.join("\n"), /Agent paused · Notifications active/);
  assert.match(open.join("\n"), /└─ ● Stopped teammate · Reviewer/);
  assert.doesNotMatch(open.join("\n"), /finding|Technical details|message wait|seq|team_message|[▸▾]/);
  assert.equal(ui.click("Message received")?.handled, true);
  let text = ui.draw().join("\n");
  assert.match(text, /First finding\n│\s+Second finding/);
  assert.equal((text.match(/Review finished/g) ?? []).length, 2, "the heading keeps its context above the full summary field");
  assert.doesNotMatch(text, /Agent:|Status:/, "sibling details remain closed");
  ui.click("Checked team status");
  text = ui.draw().join("\n");
  assert.match(text, /First finding/);
  assert.match(text, /Agent: Main agent \(this session\) \[root\]/);
  assert.match(text, /Status: Working/);
  ui.click("Message received");
  assert.doesNotMatch(ui.draw().join("\n"), /First finding/);
  assert.match(ui.draw().join("\n"), /Status: Working/);
  const retained = ui.draw();
  ui.click("ac-teams activity");
  assert.deepEqual(ui.draw(), folded);
  ui.click("ac-teams activity");
  assert.deepEqual(ui.draw(), retained, "folding the group preserves individual detail state");
  assert.ok(ui.renders() >= 6);
});

test("every expanded action retains its descriptive heading and separates details consistently", () => {
  const posts = [{ from: "m1", recipients: ["root"], summary: "Ready", detail: "Review complete" }];
  const rows = [
    tool("team_agent", { action: "list" }, { members: [{ id: "root", status: "busy" }, { id: "m1", status: "stopped" }] }),
    tool("team_message", { action: "history" }, posts),
    tool("team_message", { action: "wait" }, posts),
    tool("team_message", { action: "search" }, []),
    tool("team_message", { action: "send", recipients: ["m1"], summary: "Please review" }, { recipients: ["m1"] }),
    tool("team_task", { action: "create", title: "Review" }, { title: "Review", status: "todo" }),
    { ...tool("team_agent", { action: "launch" }), result: { details: "Launch failed", isError: true } },
    notice(posts),
  ];
  for (const row of rows) for (const width of [1, 12, 40, 160, 240]) {
    const ui = view([row], width);
    ui.click(ui.draw()[1]!);
    const closed = ui.draw().slice(2);
    ui.expand(true);
    const open = ui.draw().slice(2);
    assert.deepEqual(open.slice(0, closed.length), closed, `opening an action preserves its heading at width ${width}`);
    assert.equal(open[closed.length]!.replace(/[│]/g, "").trim(), "", "one blank line before any expanded details");
    assert.ok(open[closed.length + 1]!.replace(/[│]/g, "").trim(), "no double gap before the first detail");
    assert.equal(open.at(-1)!.replace(/[│]/g, "").trim(), "", "one blank line after any expanded details, including the last action");
    assert.ok(open.at(-2)!.replace(/[│]/g, "").trim(), "no double gap after the last detail");
    assert.ok(open.every(line => visibleWidth(line) <= width));
  }
  const empty = view([tool("team_agent", { action: "limits" }, {})]);
  empty.click("ac-teams activity");
  const closed = empty.draw();
  empty.expand(true);
  assert.deepEqual(empty.draw(), closed, "empty details do not add a blank line");
});

test("expanded details leave one gap before the next action and after native records", () => {
  const members = { members: [{ id: "root", status: "busy", model: "test-model" }] };
  const ui = view([tool("team_agent", { action: "list" }, members), tool("team_message", { action: "history" }, [])]);
  ui.expand(true);
  const lines = ui.draw(), next = lines.findIndex(line => line.includes("└─ ● Message history"));
  assert.equal(lines[next - 1]!.replace(/[│]/g, "").trim(), "", "expanded status ends with a gap before message history");
  assert.match(lines[next - 2]!, /Model: test-model/);

  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, underline: (text: string) => text } as unknown as Theme;
  const render = teamToolRenderers("team_agent").renderResult!;
  const native = render({ content: [], details: members }, { expanded: true, isPartial: false }, theme, {
    args: { action: "list" }, outputPad: 0, isError: false, keyHint: () => "",
  } as unknown as Parameters<typeof render>[3])!;
  assert.deepEqual(native.render(160).slice(-2).map(line => line.trimEnd()), ["Model: test-model", ""], "native tool details have one trailing blank line");

  const notice = teamMessageRenderer()({ role: "custom", customType: "ac-teams", content: "", display: true, timestamp: 0, details: {
    messages: [{ from: "m1", summary: "First" }, { from: "m1", summary: "Last" }],
  } }, { expanded: true, outputPad: 0 }, theme)!;
  const records = notice.render(160).map(line => line.trimEnd());
  const heading = records.findIndex((line, index) => index > 0 && line.includes("Message received"));
  assert.deepEqual(records.slice(heading - 2, heading), ["Summary: First", ""], "consecutive native records keep one gap, not two");
  assert.deepEqual(records.slice(-2), ["Summary: Last", ""], "the final native incoming record gets the same trailing gap");
});

test("multiple posts have independent rows, no last-five limit, and honest failures", () => {
  const posts = Array.from({ length: 7 }, (_, i) => ({ from: "m1", summary: `Update ${i}`, detail: `Detail ${i}` }));
  const ui = view([
    notice(posts),
    tool("team_agent", { action: "launch", name: "Broken" }, { status: "interrupted", error: "Child exited before readiness" }),
    tool("team_message", { action: "send", recipients: ["m1"], summary: "Check this" }, { recipients: [] }),
  ]);
  assert.match(ui.draw().join("\n"), /Received 7 messages; teammate failed to start; not delivered: 1 message/);
  ui.click("ac-teams activity");
  assert.equal(ui.draw().filter(line => /Message received/.test(line)).length, 7);
  assert.match(ui.draw().join("\n"), /Teammate failed to start/);
  assert.match(ui.draw().join("\n"), /Message not delivered · No recipients/);
  ui.click("Update 3");
  assert.match(ui.draw().join("\n"), /Detail 3/);
  assert.doesNotMatch(ui.draw().join("\n"), /Detail 2|Detail 4/);
});

test("global expansion opens all groups and records, collapse resets local state, and new actions follow it", () => {
  const rows = [tool("team_task", { action: "create", title: "First" }, { title: "First", status: "todo" }), other("Between groups"), notice([{ from: "m1", summary: "Ready", detail: "Full incoming body" }])];
  const ui = view(rows);
  ui.click("ac-teams activity");
  assert.doesNotMatch(ui.draw().join("\n"), /Full incoming body|Title:/);
  ui.expand(true);
  assert.match(ui.draw().join("\n"), /Title: First/);
  assert.match(ui.draw().join("\n"), /Full incoming body/);
  rows.push(tool("team_task", { action: "read", id: "t1" }, { title: "New task", status: "done" }));
  assert.match(ui.draw().join("\n"), /Title: New task/);
  ui.expand(false);
  assert.equal(ui.draw().filter(line => /● ac-teams activity/.test(line)).length, 2);
  assert.doesNotMatch(ui.draw().join("\n"), /Title:|Full incoming body/);
});

test("single actions group too; invisible notices and unrelated rows retain native visibility", () => {
  const silent = { message: { customType: "ac-teams" }, render: () => [] };
  const ui = view([silent, tool("team_task", { action: "list" }, { tasks: [] }), other("Between"), notice([{ from: "m1", summary: "Only one" }]), silent]);
  assert.deepEqual(ui.draw().filter(Boolean), ["● ac-teams activity · Task list", "Between", "● ac-teams activity · Received 1 message"]);
  assert.deepEqual(view([silent, silent]).draw(), []);
});

test("spacers and our warnings stay in the run, warnings remain visible even when folded", () => {
  const warning = other("\x1b[33mWarning: Host memory\x1b[0m");
  const ui = view([tool("team_agent", { action: "list" }), other(""), warning, tool("team_task", { action: "list" }), warning]);
  assert.deepEqual(ui.draw().filter(Boolean), ["● ac-teams activity · Checking team status; listing tasks", "Warning: Host memory", "\x1b[33mWarning: Host memory\x1b[0m"]);
  ui.click("ac-teams activity");
  assert.equal(ui.draw().filter(line => line.includes("Warning: Host memory")).length, 2, "each original warning appears once, including the trailing native warning");
  assert.equal(view([tool("team_agent", { action: "list" }), other("Warning: unrelated"), tool("team_task", { action: "list" })]).draw().filter(line => /ac-teams activity/.test(line)).length, 2);
});

test("wrapped action titles align beneath their dot, not the tree branch", () => {
  const ui = view([notice([{ from: "m1", summary: "A long summary that wraps across several lines in a narrow terminal" }]), tool("team_task", { action: "list" })], 40);
  ui.click("ac-teams activity");
  const lines = ui.draw();
  const start = lines.findIndex(line => line.startsWith("├─ ●"));
  const end = lines.findIndex(line => line.startsWith("└─ ●"));
  assert.ok(end > start + 1);
  assert.ok(lines.slice(start + 1, end).every(line => line.startsWith("│    ")), "wrapped titles align with their first line");
});

test("activity headings describe all contained work without an LLM or chevrons", () => {
  const ui = view([
    tool("team_agent", { action: "list" }, { members: [{ id: "root", status: "idle" }, { id: "m1", status: "stopped" }] }),
    tool("team_message", { action: "history" }, [{ from: "m1", recipients: ["root"], summary: "One" }, { from: "root", recipients: ["m1"], summary: "Two" }, { from: "m1", recipients: ["root"], summary: "Three" }]),
  ], 240);
  assert.deepEqual(ui.draw().filter(Boolean), ["● ac-teams activity · Checked team status; looked up 3 messages"]);
  ui.click("ac-teams activity");
  const text = ui.draw().join("\n");
  assert.match(text, /├─ ● Checked team status.*Main agent.*Ready.*Reviewer.*Stopped/);
  assert.match(text, /└─ ● Message history · 3 messages.*Reviewer.*Main agent.*Latest: Three/);
  assert.doesNotMatch(text, /[▸▾]/);
  const mixed = view([
    notice([{ from: "m1", summary: "One" }, { from: "m1", summary: "Two" }]),
    tool("team_message", { action: "send", recipients: ["m1"], summary: "Ask" }, { recipients: [] }),
    tool("team_agent", { action: "launch", name: "Broken" }, { status: "interrupted", error: "Child exited before readiness" }),
  ], 240);
  const heading = mixed.draw().join("\n");
  assert.match(heading, /Received 2 messages/);
  assert.match(heading, /not delivered/i);
  assert.match(heading, /failed to start/i);
});

test("expanded history is separated named records, not duplicate prose plus JSON", () => {
  const posts = [
    { id: "message-1", seq: 1, from: "m1", recipients: ["root"], summary: "Ready to review", detail: "First line\nLast line\x1b[2J", time: "2026-11-04T21:47:26Z" },
    { id: "message-2", seq: 2, from: "root", recipients: ["m1"], summary: "Please check", detail: "Check cancellation" },
    { id: "message-3", seq: 3, from: "m1", recipients: ["root"], summary: "All clear", kind: "outcome", task: "task-1" },
  ];
  const before = JSON.stringify(posts);
  const ui = view([tool("team_message", { action: "history", limit: 3 }, posts)]);
  ui.expand(true);
  const text = ui.draw().join("\n");
  assert.match(text, /Message 1 · Received/);
  assert.match(text, /Message 2 · Sent/);
  assert.match(text, /Message 3 · Received/);
  assert.match(text, /From: Reviewer \[m1\]/);
  assert.match(text, /To: Main agent \(this session\) \[root\]/);
  assert.match(text, /Summary: Ready to review/);
  assert.match(text, /Message:\n\s+First line\n\s+Last line/);
  assert.match(text, /Task completed/);
  assert.equal((text.match(/Ready to review/g) ?? []).length, 1);
  const lines = ui.draw();
  for (const heading of ["Message 1 · Received", "Message 2 · Sent", "Message 3 · Received"]) {
    const index = lines.findIndex(line => line.includes(heading));
    assert.equal(lines[index - 1]!.replace(/[│]/g, "").trim(), "", "every message section starts after a blank line, including the first");
  }
  assert.doesNotMatch(text, /Technical details|"from"|"result"|"arguments"|message-1|\bSeq:|\x1b/);
  assert.equal(JSON.stringify(posts), before);
});

test("headers distinguish pending work, repeated operations, sends and empty lookups", () => {
  const ui = view([
    tool("team_task", { action: "create", title: "First" }),
    tool("team_agent", { action: "status" }),
    tool("team_agent", { action: "status" }),
    tool("team_message", { action: "history" }, []),
    tool("team_message", { action: "send", summary: "Hello", recipients: ["m1"] }),
  ], 240);
  const text = ui.draw().join("\n");
  assert.match(text, /Creating tasks; checking team status \(2 times\); looked up 0 messages; sending 1 message/);
  assert.doesNotMatch(text, /Tasks created|Checked team status|Sent 1 message/);
});

test("padding, narrow widths, full multiline bodies and sanitization survive tree rendering", () => {
  for (const outputPad of [0, 1, 3]) {
    for (const width of [1, 2, 12, 40, 80]) {
      const post = { ...notice([{ from: "m1", summary: "Ready", detail: "\x1b[31mFull message\x1b[0m\nLast line" }]), outputPad };
      const ui = view([post, tool("team_task", { action: "list" }, { tasks: [] })], width);
      assert.ok(ui.draw().every(line => visibleWidth(line) <= width));
      ui.expand(true);
      const lines = ui.draw();
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      if (width === 80) {
        const pad = " ".repeat(outputPad);
        assert.ok(lines.filter(Boolean).every(line => line.startsWith(pad)));
        assert.match(lines.join("\n"), /Full message/);
        assert.match(lines.join("\n"), /Last line/);
        assert.doesNotMatch(lines.join("\n"), /\x1b/);
      }
    }
  }
});
