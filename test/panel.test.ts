import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, indexedColor, setKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { cleanText } from "../src/ui/render.ts";
import { showTeamsPanel } from "../src/ui/panel.ts";
import { panelFormat } from "../src/ui/panel-format.ts";
import { taskDetails } from "../src/ui/panel-details.ts";
import { panelLists } from "../src/ui/panel-lists.ts";
import type { PanelHost, TeamSnapshot } from "../src/ui/types.ts";
import type { TaskView } from "../src/types.ts";

const task = (id: string, overrides: Partial<TaskView> = {}): TaskView => ({
  id, number: Number(id.replace(/^T/, "")) || 1, label: `Task ${id}`, revision: 1, title: `Task ${id}`, description: "Real task description", dependencies: [], completionDependencies: [], status: "todo", blockedBy: [], completionBlockedBy: [], ...overrides,
});
const tasks = [task("T03", { status: "done" }), task("T12", { status: "in_progress", dependencies: ["T03"] }),
  task("T21", { dependencies: ["T03"] }), task("T18", { dependencies: ["T12", "T21"], blockedBy: ["T12", "T21"] })];
// SAFETY: these bounded Pi doubles implement only the documented methods the UI uses.
const theme = {
  fg(color: string, text: string) { return `\x1b[${color === "dim" ? 90 : color === "accent" ? 95 : 37}m${text}\x1b[39m`; },
  bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
  underline(text: string) { return `\x1b[4m${text}\x1b[24m`; },
  style(text: string, options: { fg: Parameters<typeof foregroundAnsi>[0] }) { return foregroundAnsi(options.fg, "256color") + text + "\x1b[39m"; },
} as unknown as Theme;

const plain = (component: Component, width = 60) => component.render(width).map(line => cleanText(line).trimEnd()).join("\n");

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

initTheme("dark", false);
setKeybindings(new KeybindingsManager());

async function panelFixture(snapshot: TeamSnapshot, view?: { graph: boolean }) {
  let component: Component & { dispose?(): void; handleInput(data: string): void };
  let close: (id?: string) => void = () => {};
  const visits: string[] = [], resumes: string[] = [], sent: string[] = [];
  const host: PanelHost = { self: "root", child: false, promote: async () => {}, drafts: new Map(), snapshot: async () => snapshot,
    visit: async id => { visits.push(id); }, resume: async id => { resumes.push(id); },
    requestTask: async text => { sent.push(text); return "Delivered to Main"; },
    feedback: async (_task, text) => { sent.push(text); return "Delivered feedback"; } };
  const tui = { terminal: { rows: 32, columns: 100 }, requestRender() {} };
  const ctx = { mode: "tui", cwd: "/project", ui: { notify() {},
    custom: (factory: (...args: unknown[]) => typeof component) => new Promise<string | undefined>(resolve => {
      close = id => { component.dispose?.(); resolve(id); };
      component = factory(tui, theme, {}, close);
    }),
  } } as unknown as ExtensionContext;
  const running = showTeamsPanel(ctx, host, view);
  await tick();
  return { host, tui, component: component!, visits, resumes, sent, running, close: () => close(),
    text: (width = 100) => plain(component!, width) };
}

const snapshot = (): TeamSnapshot => ({ members: [], tasks: tasks.map(item => ({ ...item })), messages: [], limit: 4, depth: 2 });

test("task details distinguish start and finish prerequisites and unlocks", () => {
  const producer = task("T1");
  const consumer = task("T2", { completionDependencies: [producer.id], completionBlockedBy: [producer.id] });
  const data = [producer, consumer];
  const style = panelFormat(theme, data, []);
  const details = (item: TaskView) => taskDetails(item, data, [], style, 150).map(cleanText).join("\n");
  assert.match(details(consumer), /Start needs +Nothing; can start now/);
  assert.match(details(consumer), /Finish also needs +#1 Task T1/);
  assert.match(details(consumer), /Finish blocked by +#1 Task T1/);
  assert.match(details(producer), /Unlocks +#2 Task T2 \(finish\)/);
});

test("panel views render explicit data without changing selection or snapshots", () => {
  const data: Parameters<typeof panelLists>[0] = {
    tasks: structuredClone(tasks), members: [], messages: [], events: [], ids: ["root"],
    taskIndex: 1, memberIndex: 0, eventIndex: 0, tab: 0, detail: false, graph: false,
    scroll: 999, detailScroll: 999, width: 100, bodyHeight: 12,
    session: { self: "root", child: false, cwd: "/project" },
  };
  const before = structuredClone(data);
  const style = panelFormat(theme, data.tasks, data.members);
  for (const tab of [0, 1, 2]) for (const detail of [false, true]) for (const width of [40, 100]) {
    const input = { ...data, tab, detail, width };
    const inputBefore = structuredClone(input);
    const result = panelLists(input, style);
    assert.deepEqual(result, panelLists(input, style));
    assert.deepEqual(input, inputBefore);
    assert.ok(result.lines.length <= data.bodyHeight);
    assert.ok(result.scroll >= 0 && result.detailScroll >= 0);
  }
  assert.deepEqual(data, before);
});

test("panel keeps selected status color, dims done text, fits narrow terminals, and has empty states", async () => {
  const f = await panelFixture(snapshot(), { graph: true });
  try {
    const lines = f.component.render(150);
    assert.match(lines.join("\n"), new RegExp(foregroundAnsi(indexedColor(2), "256color").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(lines.some(line => line.includes("\x1b[90m") && line.includes("● #3 Task T03")));
    assert.match(f.text(150), /● #3 Task T03 · Done/);
    assert.match(f.text(150), /Working/);
    assert.ok(lines.join("\n").includes(foregroundAnsi(indexedColor(6), "256color")));
    assert.ok(lines.join("\n").includes(foregroundAnsi(indexedColor(1), "256color")));
    f.component.handleInput("g");
    assert.match(f.text(), /● #3 Task T03/);
    assert.ok(!f.text().includes("> #"));
    assert.match(f.text(), /Done/);
    f.tui.terminal.rows = 10;
    assert.ok(f.component.render(12).every(line => visibleWidth(line) <= 12));
    assert.ok(f.component.render(12).length <= 10);
  } finally { f.close(); await f.running; }
  const empty = await panelFixture({ ...snapshot(), tasks: [], members: [{ id: "root", cwd: "/project", depth: 0, status: "idle", notified: 0 }] });
  try {
    assert.match(empty.text(), /No tasks yet/);
    assert.match(empty.text(), /0\/4 live/, "Main must not consume a member slot");
    empty.component.handleInput("\t");
    assert.match(empty.text(), /● Main/);
    assert.match(empty.text(150), /Model +Unknown/);
    assert.match(empty.text(150), /Context +Unknown/);
    assert.match(empty.text(150), /Directory +\/project/);
    empty.component.handleInput("\t");
    assert.match(empty.text(), /No posts yet/);
  } finally { empty.close(); await empty.running; }
});

test("go to task validates task numbers and selects in list and graph views", async () => {
  for (const graph of [false, true]) {
    const f = await panelFixture(snapshot(), { graph });
    try {
      f.text(150);
      f.component.handleInput("J");
      assert.match(f.text(150), /Go to task:/);
      f.component.handleInput("999"); f.component.handleInput("\r");
      assert.match(f.text(150), /Task #999 does not exist/);
      assert.match(f.text(150), /● #3 Task T03/);
      for (let i = 0; i < 3; i++) f.component.handleInput("\x7f");
      f.component.handleInput("abc"); f.component.handleInput("\r");
      assert.match(f.text(150), /Enter a positive task number/);
      f.component.handleInput("\x1b");
      assert.doesNotMatch(f.text(150), /Go to task:/);
      f.component.handleInput("J"); f.component.handleInput("21"); f.component.handleInput("\r");
      assert.doesNotMatch(f.text(150), /Go to task:/);
      assert.match(f.text(150), /● #21 Task T21/);
      f.component.handleInput("\r");
      assert.match(f.text(150), /ID +T21/);
    } finally { f.close(); await f.running; }
  }
});

test("task shortcuts fit one line at 132 columns and wrap completely in smaller terminals", async () => {
  for (const graph of [true, false]) {
    const f = await panelFixture(snapshot(), { graph });
    const footer = (width: number) => {
      const lines = f.component.render(width).map(cleanText);
      return lines.slice(lines.findLastIndex(line => line.startsWith("├")) + 1, -1);
    };
    try {
      const wide = footer(132);
      assert.equal(wide.length, 1, "laptop-width shortcuts occupy one row");
      assert.match(wide[0], /Shift\+J Jump/);
      assert.ok(wide[0].includes(graph ? "G List" : "G Graph"));
      for (const label of ["Enter Details", "C Feedback", "N New", "Tab Next", "Esc Close", ...(graph ? ["A All/Focus", "+/- Zoom", "F Fit"] : [])]) assert.ok(wide[0].includes(label), label);
      if (graph) { f.component.handleInput("a"); assert.equal(footer(132).length, 1, "full-map shortcuts also fit"); }
      const narrow = footer(70);
      assert.ok(narrow.length > 1, "narrow viewports wrap rather than hide shortcuts");
      assert.match(narrow.join(" "), /Esc Close/);
      assert.ok(narrow.every(line => visibleWidth(line) <= 70));
    } finally { f.close(); await f.running; }
  }
});

test("Vim keys mirror arrows across views without consuming text entry", async () => {
  for (const graph of [false, true]) {
    const vim = await panelFixture(snapshot(), { graph }), arrows = await panelFixture(snapshot(), { graph });
    try {
      assert.equal(vim.text(150), arrows.text(150));
      for (const [letter, key] of [["j", "\x1b[B"], ["k", "\x1b[A"], ["l", "\x1b[C"], ["h", "\x1b[D"]]) {
        vim.component.handleInput(letter); arrows.component.handleInput(key);
        assert.equal(vim.text(150), arrows.text(150), `${letter} mirrors its arrow`);
        assert.doesNotMatch(vim.text(150), /Go to task:/);
      }
      vim.component.handleInput("\t"); arrows.component.handleInput("\t");
      vim.component.handleInput("h"); arrows.component.handleInput("\x1b[D");
      assert.equal(vim.text(150), arrows.text(150), "h does not toggle the stopped-member filter");
      vim.component.handleInput("l"); arrows.component.handleInput("\x1b[C");
      assert.equal(vim.text(150), arrows.text(150));
      vim.component.handleInput("h"); arrows.component.handleInput("\x1b[D");
      assert.equal(vim.text(150), arrows.text(150));
      assert.match(vim.text(150), /Filter.*Hide stopped/);
      vim.component.handleInput("/"); vim.component.handleInput("hjkl");
      assert.match(vim.text(150), /Filter: hjkl/);
      vim.component.handleInput("\x1b"); vim.component.handleInput("\x1b[Z");
      vim.component.handleInput("J"); vim.component.handleInput("hjkl");
      assert.match(vim.text(150), /Go to task: hjkl/);
      vim.component.handleInput("\x1b"); vim.component.handleInput("n"); vim.component.handleInput("hjkl");
      assert.match(vim.text(150), /hjkl/);
    } finally { vim.close(); arrows.close(); await Promise.all([vim.running, arrows.running]); }
  }
});

test("page keys move a viewport of entries, clamp boundaries, and scroll the correct details", async () => {
  const data = snapshot();
  data.tasks = Array.from({ length: 60 }, (_, i) => task(`T${i + 1}`, { owner: "root", description: "Long task description. ".repeat(500) }));
  data.members = Array.from({ length: 60 }, (_, i) => ({ id: `worker${i + 1}`, cwd: "/project", depth: 1, status: "idle", notified: 0 }));
  data.messages = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, id: `M${i + 1}`, from: "root", recipients: [], summary: `Post ${i + 1}`, detail: "Long board evidence. ".repeat(500), time: "2026-01-01T12:00:00Z" }));
  const f = await panelFixture(data);
  const page = (headerRows: number) => {
    const lines = f.component.render(160).map(cleanText), separators = lines.flatMap((line, i) => line.startsWith("├") ? [i] : []);
    return separators[1] - separators[0] - 1 - headerRows;
  };
  try {
    const step = page(2);
    f.component.handleInput("\x1b[6~");
    assert.match(f.text(160), new RegExp(`● #${step + 1} Task T${step + 1}\\b`));
    f.component.handleInput("\x1b[5~"); assert.match(f.text(160), /● #1 Task T1\b/);
    for (let i = 0; i < 6; i++) f.component.handleInput("\x1b[6~");
    assert.match(f.text(160), /● #60 Task T60\b/);
    for (let i = 0; i < 6; i++) f.component.handleInput("\x1b[5~");
    f.component.handleInput("l"); const detail = f.text(160);
    assert.match(detail, /#1 Task T1 · Ready/);
    f.component.handleInput("\x1b[6~"); assert.notEqual(f.text(160), detail);
    f.component.handleInput("\x1b[5~"); assert.equal(f.text(160), detail);
    f.component.handleInput("h"); f.component.handleInput("g"); const graphStep = page(2);
    f.component.handleInput("\x1b[6~"); assert.match(f.text(160), new RegExp(`#${graphStep + 1} Task T${graphStep + 1}\\b`));
    f.component.handleInput("\x1b[5~"); assert.match(f.text(160), /#1 Task T1\b/);
    f.component.handleInput("g"); f.component.handleInput("\t");
    const memberStep = page(1);
    f.component.handleInput("\x1b[6~"); assert.match(f.text(160), new RegExp(`● worker${memberStep}\\b`));
    f.component.handleInput("\x1b[5~"); assert.match(f.text(160), /● Main\b/);
    f.component.handleInput("l"); const member = f.text(160);
    f.component.handleInput("\x1b[6~"); assert.notEqual(f.text(160), member);
    f.component.handleInput("\x1b[5~"); assert.equal(f.text(160), member);
    f.component.handleInput("h"); f.component.handleInput("\t"); const boardStep = page(1);
    f.component.handleInput("\x1b[6~"); assert.match(f.text(160), new RegExp(`● Main.*Post ${60 - boardStep}\\b`));
    f.component.handleInput("\x1b[5~"); f.component.handleInput("l");
    const post = f.text(160);
    assert.match(post, /Post 60/); assert.match(post, /Long board evidence/);
    f.component.handleInput("\x1b[6~"); assert.notEqual(f.text(160), post);
    f.component.handleInput("\x1b[5~"); assert.equal(f.text(160), post);
    f.component.handleInput("h"); assert.match(f.text(160), /● Main.*Post 60/);
  } finally { f.close(); await f.running; }
});

test("list opening and background refreshes do no graph work until a graph is rendered", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let graphScans = 0;
  const segment = Intl.Segmenter.prototype.segment;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string) {
    if (input.includes("┌")) graphScans++;
    return segment.call(this, input);
  });
  const data = snapshot(), view = { graph: false };
  const f = await panelFixture(data, view);
  try {
    assert.doesNotMatch(f.text(150), /Zoom \d+%/);
    assert.equal(graphScans, 0);
    f.host.snapshot = async () => ({ ...data, tasks: data.tasks.map(item => ({ ...item, title: "Updated task" })) });
    t.mock.timers.tick(2000); await tick();
    assert.match(f.text(150), /Updated task/);
    assert.equal(graphScans, 0, "list refresh must not build a graph");
    f.component.handleInput("g");
    assert.equal(view.graph, true);
    assert.equal(graphScans, 0, "graph construction waits for rendering");
    assert.match(f.text(150), /Zoom \d+%/);
    assert.ok(graphScans > 0);
    f.component.handleInput("\t"); f.component.handleInput("\t");
    const previous = graphScans;
    f.host.snapshot = async () => ({ ...data, tasks: data.tasks.map(item => ({ ...item, title: "Changed again" })) });
    t.mock.timers.tick(2000); await tick();
    f.text(150);
    assert.equal(graphScans, previous, "board refresh must not rebuild an invisible graph");
    f.component.handleInput("\t");
    assert.match(f.text(150), /Changed again/);
    assert.ok(graphScans > previous, "returning to the graph rebuilds it from the new tasks");
  } finally { f.close(); await f.running; }
});

test("graph renders many independent tasks without multiplying ANSI sequences", async () => {
  const data = snapshot();
  data.tasks = Array.from({ length: 24 }, (_, index) => task(`demo-${index}`, {
    number: index + 1, title: `Demo ${index + 1} ${"Long scheduling title ".repeat(6)}`, dependencies: [],
  }));
  const f = await panelFixture(data, { graph: true });
  try {
    for (const width of [40, 100, 132, 180]) {
      const lines = f.component.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.ok(lines.join("").length < 100000, "ANSI output stays bounded");
    }
  } finally { f.close(); await f.running; }
});

test("task list aligns statuses for short, long, and wide titles", async () => {
  const data = snapshot();
  data.tasks = data.tasks.map((item, index) => ({ ...item, title: ["Short", "Long title ".repeat(30), "解析器 👩‍💻".repeat(20), "Blocked task"][index] }));
  const f = await panelFixture(data);
  try {
    for (const width of [40, 80, 100, 150]) {
      const lines = f.component.render(width).map(cleanText).map(line => line.split(" │ ")[0].replace(/ │$/, ""));
      const header = lines.find(line => /Task +State/.test(line));
      assert.ok(header, `task headings at width ${width}`);
      const column = visibleWidth(header.slice(0, header.indexOf("State")));
      for (const status of ["Done", "Working", "Ready", "Blocked"]) {
        const row = lines.find(line => new RegExp(`${status} *$`).test(line));
        assert.ok(row, `${status} visible at width ${width}`);
        assert.equal(visibleWidth(row.slice(0, row.lastIndexOf(status))), column, `${status} aligned at width ${width}`);
      }
    }
    for (let width = 12; width <= 180; width++) {
      assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
    }
    assert.ok(f.component.render(80).some(line => line.includes("\x1b[95m● ")), "selected marker uses accent even for done tasks");
  } finally { f.close(); await f.running; }
});

test("all table headers use bold underlined accent styling", async () => {
  const data = snapshot();
  data.messages = [{ seq: 1, id: "M1", from: "root", recipients: [], summary: "Update", time: "2026-01-01T12:00:00Z" }];
  const f = await panelFixture(data);
  try {
    for (const label of ["Task", "Member", "From"]) {
      const header = f.component.render(150).find(line => cleanText(line).includes(`  ${label} `));
      assert.ok(header, `${label} header exists`);
      assert.ok(header.includes("\x1b[95m"), `${label} uses accent`);
      assert.ok(header.includes("\x1b[1m"), `${label} is bold`);
      assert.ok(header.includes("\x1b[4m"), `${label} is underlined`);
      f.component.handleInput("\t");
    }
  } finally { f.close(); await f.running; }
});

test("teammate columns stay aligned and preserve status at narrow and split widths", async () => {
  const data = snapshot();
  data.members = [
    { id: "scout", name: "marketplace-scout", status: "stopped", depth: 1, cwd: "/project", notified: 0 },
    { id: "fix", name: "setup-fix", status: "busy", depth: 1, cwd: "/project", notified: 0 },
    { id: "wide", name: "解析器👩‍💻".repeat(12), status: "idle", needsInput: true, depth: 1, cwd: "/project", notified: 0 },
  ];
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t");
    for (const width of [40, 80, 100, 150]) {
      const rendered = f.component.render(width).map(cleanText);
      const lines = rendered.map(line => line.split(" │ ")[0]); // roster column only; details repeat the state
      const header = lines.find(line => /Member +State/.test(line))!;
      assert.ok(header, `column headings at width ${width}`);
      const column = visibleWidth(header.slice(0, header.indexOf("State")));
      for (const status of ["Main conversation", "Stopped", "Busy", "Needs input"]) {
        const line = lines.find(line => line.includes(status))!;
        assert.ok(line, `${status} visible at width ${width}`);
        assert.equal(visibleWidth(line.slice(0, line.indexOf(status))), column, `${status} aligned at width ${width}`);
      }
      assert.ok(rendered.every(line => visibleWidth(line) <= width));
    }
    for (const width of [12, 24, 39, 82, 83]) {
      assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
    }
    f.component.handleInput("\x1b[B");
    assert.match(f.text(80), /● marketplace-scout/);
    f.component.handleInput("\x1b[C");
    assert.match(f.text(80), /marketplace-scout · Stopped/);
  } finally { f.close(); await f.running; }
});

test("teammate table adds task progress and directory only when they fit", async () => {
  const data = snapshot();
  data.members = [
    { id: "worker", name: "marketplace-fix", status: "busy", depth: 1, cwd: "/work/marketplace/", notified: 0 },
    { id: "other", name: "other", status: "idle", depth: 1, cwd: "/work/解析器", notified: 0 },
  ];
  data.tasks = data.tasks.map((task, i) => ({ ...task, owner: i < 3 ? "worker" : "other", status: i === 0 ? "done" : "todo" }));
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t");
    const wide = f.component.render(150).map(cleanText);
    const header = wide.find(line => /Member +State +Done +Directory/.test(line))!;
    assert.ok(header);
    const worker = wide.find(line => /marketplace-fix +Busy/.test(line))!;
    assert.match(worker, /marketplace-fix {4,}Busy {4,}1\/3 {4,}marketplace/);
    for (const [title, value] of [["State", "Busy"], ["Done", "1/3"], ["Directory", "marketplace"]]) {
      assert.equal(visibleWidth(header.slice(0, header.indexOf(title))), visibleWidth(worker.slice(0, worker.lastIndexOf(value))));
    }
    assert.ok(!worker.includes("/work/"));
    assert.match(wide.find(line => /other +Idle/.test(line))!, /0\/1 +解析器/);
    const columnAt = (width: number, title: string) => {
      const heading = f.component.render(width).map(cleanText).find(line => /Member +State/.test(line))!;
      return visibleWidth(heading.slice(0, heading.indexOf(title)));
    };
    assert.ok(columnAt(180, "State") > columnAt(150, "State"), "State moves with available width");
    assert.ok(columnAt(180, "Done") > columnAt(150, "Done"), "Done moves with available width");
    assert.ok(columnAt(180, "Directory") > columnAt(150, "Directory"), "Directory uses the right-hand space");
    const medium = f.text(100).split("\n").find(line => /Member +State/.test(line))!;
    assert.match(medium, /Done/);
    assert.ok(!medium.includes("Directory"));
    const narrow = f.text(40).split("\n").find(line => /Member +State/.test(line))!;
    assert.ok(!narrow.includes("Done"));
    assert.ok(!narrow.includes("Directory"));
    for (let width = 12; width <= 180; width++) {
      assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
    }
    f.component.handleInput("\x1b[B"); f.component.handleInput("\x1b[C");
    assert.match(f.text(100), /Tasks \(1 of 3 done\)/);
    assert.match(f.text(100), /Directory +\/work\/marketplace\//);
    data.tasks[1].owner = "other";
    assert.match(f.text(100), /Tasks \(1 of 2 done\)/, "reassignment leaves the denominator");
  } finally { f.close(); await f.running; }
});

test("teammate search and stopped filter affect only the visible roster and selected session", async () => {
  const data = snapshot();
  data.members = [
    { id: "scout-id", name: "marketplace-scout", role: "member", status: "stopped", depth: 1, cwd: "/project", notified: 0 },
    { id: "fix-id", name: "marketplace-fix", role: "member", status: "busy", depth: 1, cwd: "/project", notified: 0 },
    { id: "test-id", name: "setup-tests", role: "member", status: "idle", needsInput: true, depth: 1, cwd: "/project", notified: 0 },
    { id: "interrupted-id", name: "interrupted-review", role: "member", status: "interrupted", depth: 1, cwd: "/project", notified: 0 },
  ];
  const before = JSON.stringify(data);
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t");
    assert.match(f.text(150), /1 working · 0 idle · 1 stopped · 2 needs input/);
    assert.match(f.text(150), /Enter  Open session/);
    const footer = () => { const text = f.text(150); return text.slice(text.lastIndexOf("├")); };
    assert.match(footer(), /\/ Filter · H Hide stopped/);
    const rows = f.component.render(150).map(cleanText);
    const headingRow = rows.findIndex(line => /Member +State/.test(line));
    assert.match(rows[headingRow + 1], /● Main/, "headings sit directly above roster rows");
    assert.ok(!rows.slice(0, rows.findLastIndex(line => line.includes("├"))).some(line => /Filter names|H Hide stopped/.test(line)));
    f.component.handleInput("H");
    assert.ok(!f.text(150).includes("marketplace-scout"));
    assert.match(footer(), /Stopped: hidden/);
    assert.match(f.text(150), /interrupted-review/, "interrupted sessions remain visible for recovery");
    f.component.handleInput("/");
    f.component.handleInput("MARKETPLACE");
    assert.match(footer(), /Filter: MARKETPLACE▏/);
    assert.match(footer(), /Stopped: hidden/);
    assert.match(f.text(150), /● marketplace-fix/);
    assert.ok(!f.text(150).includes("setup-tests"));
    assert.deepEqual(f.sent, [], "search input must not trigger task or promotion shortcuts");
    f.component.handleInput("\r");
    assert.match(footer(), /Filter: MARKETPLACE/);
    f.component.handleInput("\x1b[C");
    assert.match(f.text(150), /Esc Back/);
    assert.ok(!f.text(150).includes("No separate message composer"));
    f.component.handleInput("\x1b");
    f.component.handleInput("/");
    f.component.handleInput("does-not-exist");
    assert.match(f.text(150), /No matching teammates/);
    f.component.handleInput("\r");
    f.component.handleInput("\r");
    await tick();
    assert.deepEqual(f.visits, [], "empty search cannot open an unrelated member");
    f.component.handleInput("/");
    f.component.handleInput("\x1b");
    assert.match(f.text(150), /setup-tests/);
    f.component.handleInput("H");
    assert.match(f.text(150), /marketplace-scout/);
    assert.equal(JSON.stringify(data), before);
    f.component.handleInput("/");
    f.component.handleInput("\x1b[200~marketplace-fix😀\x1b[201~");
    f.component.handleInput("\x7f");
    assert.match(f.text(150), /● marketplace-fix/);
    f.component.handleInput("\r");
    f.component.handleInput("\r");
    await tick(); await f.running;
    assert.deepEqual(f.visits, ["fix-id"]);
  } finally { f.close(); await f.running; }
});

test("panel summaries follow the active tab and details separate model from context", async () => {
  const data = snapshot();
  data.members = [{ id: "worker", name: "worker", status: "idle", depth: 1, cwd: "/project", notified: 0,
    modelName: "Test model", contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 } }];
  data.messages = [{ seq: 1, id: "M1", from: "root", recipients: ["worker"], summary: "Hello", time: "2026-01-01T12:00:00Z" }];
  const f = await panelFixture(data);
  try {
    assert.match(f.text(150), /4 tasks/);
    f.component.handleInput("\t"); f.component.handleInput("\x1b[B");
    assert.match(f.text(150), /1 teammate/);
    assert.ok(!f.text(150).includes("4 tasks"));
    assert.match(f.text(150), /Model +Test model/);
    assert.match(f.text(150), /Context +12k \/ 100k \(12%\)/);
    f.component.handleInput("\t");
    assert.match(f.text(150), /1 post · 0 outcomes · 0 replies/);
    assert.ok(!f.text(150).includes("4 tasks"));
  } finally { f.close(); await f.running; }
});

test("composer retains failed/cancelled drafts, uses real receipts, and resumes before visiting", async () => {
  const data = snapshot();
  data.members.push({ id: "worker", depth: 1, cwd: "/project", status: "stopped", notified: 0 });
  const f = await panelFixture(data);
  try {
    f.host.requestTask = async () => { throw new Error("offline\x1b[2J"); };
    f.component.handleInput("n"); f.component.handleInput("Build parser"); f.component.handleInput("\r");
    await tick();
    assert.match(f.text(), /Delivery failed: Error: offline/);
    assert.equal(f.host.drafts.get("new"), "Build parser");
    f.component.handleInput("\x1b");
    assert.equal(f.host.drafts.get("new"), "Build parser");
    f.component.handleInput("n");
    assert.match(f.text(), /Main will review existing work/);
    f.host.requestTask = async text => { f.sent.push(text); return "Receipt M42: delivered to Main"; };
    f.component.handleInput("\r"); await tick();
    assert.deepEqual(f.sent, ["Build parser"]);
    assert.equal(f.host.drafts.has("new"), false);
    assert.match(f.text(), /Receipt M42: delivered to Main/);
    f.component.handleInput("\t"); f.component.handleInput("\x1b[B");
    f.component.handleInput("\r"); await tick(); await f.running;
    assert.deepEqual(f.resumes, ["worker"]);
    assert.deepEqual(f.visits, ["worker"]);
  } finally { f.close(); await f.running; }
});

test("polling preserves task identity, never overlaps, and stops after disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = snapshot();
  const f = await panelFixture(data);
  let calls = 0;
  let resolve: (value: TeamSnapshot) => void = () => {};
  try {
    f.component.handleInput("\x1b[B"); f.component.handleInput("\x1b[B");
    assert.match(f.text(), /● #21 Task T21/);
    f.host.snapshot = () => { calls++; return new Promise(done => { resolve = done; }); };
    t.mock.timers.tick(2000); await tick();
    assert.equal(calls, 1);
    t.mock.timers.tick(10000); await tick();
    assert.equal(calls, 1);
    resolve({ ...data, tasks: [data.tasks[2], data.tasks[0], data.tasks[1], data.tasks[3]] });
    await tick();
    assert.match(f.text(), /● #21 Task T21/);
    t.mock.timers.tick(2000); await tick();
    assert.equal(calls, 2);
    f.close(); await f.running;
    resolve(data); await tick();
    t.mock.timers.tick(10000); await tick();
    assert.equal(calls, 2);
  } finally { f.close(); await f.running; }
});

test("fallback does not overwrite delivery receipts and Activity uses persistent messages", async () => {
  const data = snapshot();
  data.tasks = [task("T1", { dependencies: ["missing"] })];
  data.messages = [{ seq: 1, id: "M1", from: "root", recipients: ["worker"], summary: "Real persistent message", time: "2026-01-01T12:00:00Z" }];
  const f = await panelFixture(data, { graph: true });
  try {
    assert.match(f.text(), /Graph unavailable or too large/);
    f.component.handleInput("n"); f.component.handleInput("Describe outcome"); f.component.handleInput("\r");
    await tick();
    assert.match(f.text(), /Delivered to Main/);
    assert.match(f.text(), /Delivered to Main/);
    f.component.handleInput("\t"); f.component.handleInput("\t");
    assert.match(f.text(), /Real persistent message/);
    assert.match(f.text(), /From +Kind +Summary +Task +Time/);
    assert.match(f.text(), /● Main +Post +Real persistent message/);
  } finally { f.close(); await f.running; }
});

test("Board shows headline, full title, time, and detail tiers for outcomes and replies", async () => {
  const data = snapshot();
  data.tasks = [task("T1", { title: "Count lines in c.txt", status: "done" })];
  data.messages = [
    { seq: 1, id: "M1", from: "root", recipients: ["worker"], summary: "Which file?", time: "2026-01-01T12:00:00Z" },
    { seq: 2, id: "M2", from: "worker", recipients: ["root"], summary: "15 lines\nCounted with wc", detail: "Exact output: 15 c.txt", task: "T1", kind: "outcome", time: "2026-01-01T12:00:05Z" },
    { seq: 3, id: "M3", from: "worker", recipients: ["root"], summary: "c.txt", replyTo: "M1", time: "2026-01-01T12:00:06Z" },
  ];
  data.members.push({ id: "worker", name: "worker", depth: 1, cwd: "/project", status: "idle", notified: 0 });
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t"); f.component.handleInput("\t");
    assert.match(f.text(150), /3 posts · 1 outcomes · 1 replies/);
    assert.match(f.text(150), /● worker +Reply +c\.txt/);
    assert.match(f.text(150), /Reply to +Main: Which file\?/);
    f.component.handleInput("\x1b[B");
    const text = f.text(150);
    assert.match(text, /● worker +Outcome +15 lines +#\d+ +\d\d:\d\d/, "one row: who, kind, summary headline, task, time");
    assert.match(text, /Task +#\d+ Count lines in c\.txt · Done/, "detail names the full task title");
    assert.match(text, /Summary ─+/);
    assert.match(text, /Detail ─+/);
    assert.match(text, /Exact output: 15 c\.txt/);
    f.component.handleInput("\x1b[B");
    assert.match(f.text(150), /Replies \(1\)/);
    assert.match(f.text(150), /worker: c\.txt/);
  } finally { f.close(); await f.running; }
});

test("dense graphs focus on real neighbors, retain blocked status, and toggle the full map", async () => {
  const data = snapshot();
  data.tasks = Array.from({ length: 60 }, (_, i) => task(`T${i + 1}`, {
    title: `Implement readable task ${i + 1}`,
    dependencies: i ? [`T${i}`] : [], blockedBy: i ? [`T${i}`] : [],
  }));
  const before = JSON.stringify(data);
  const f = await panelFixture(data, { graph: true });
  try {
    assert.match(f.text(100), /Focus: 2 of 60 tasks/);
    assert.match(f.text(100), /● #1 Implement readable task 1/);
    assert.doesNotMatch(f.text(100), /Zoom 0%|\(fit\)/);
    f.component.handleInput("\x1b[B");
    const next = f.text(100);
    assert.match(next, /Focus: 3 of 60 tasks/);
    assert.match(next, /● #2 Implement readable task 2/);
    assert.match(next, /Blocked/);
    f.component.handleInput("a");
    assert.match(f.text(100), /Full map: 60 tasks/);
    assert.match(f.text(100), /pan to explore/);
    assert.doesNotMatch(f.text(100), /\(fit\)/);
    f.component.handleInput("a");
    assert.match(f.text(100), /Focus: 3 of 60 tasks/);
    f.component.handleInput("\r");
    assert.match(f.text(100), /Dependencies/);
    f.component.handleInput("\x1b");
    assert.match(f.text(100), /Focus: 3 of 60 tasks/);
    assert.equal(JSON.stringify(data), before);
    for (const width of [40, 60, 150]) {
      assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width));
    }
  } finally { f.close(); await f.running; }
});

test("full maps show verified crossing legends and short focus viewports explicitly fall back", async () => {
  const data = snapshot();
  data.tasks = Array.from({ length: 6 }, (_, i) => task(`T${i + 1}`, {
    title: `Task ${i + 1}`, dependencies: i < 3 ? [] : ["T1", "T2", "T3"], blockedBy: i < 3 ? [] : ["T1", "T2", "T3"],
  }));
  const f = await panelFixture(data, { graph: true });
  try {
    for (const rows of [20, 21, 22, 23, 24, 25, 26, 32]) {
      f.tui.terminal.rows = rows;
      const automatic = f.text(160);
      if (automatic.includes("Full map:")) assert.doesNotMatch(automatic, /pan to explore/, "automatic fit includes the bridge spacer rows");
    }
    let full = f.text(160);
    if (!full.includes("Full map:")) { f.component.handleInput("a"); full = f.text(160); }
    assert.match(full, /Full map: 6 tasks/);
    assert.match(full, /Rounded bridges \(1\); other overlaps unchanged/);
    assert.match(full, /╭─╮/, "the displayed diagram uses connected rounded bridge strokes");
    assert.doesNotMatch(full, /┼.*junction/);
    f.component.handleInput("a");
    assert.match(f.text(160), /Focused task/);
    assert.doesNotMatch(f.text(160), /Rounded bridges|Line jumps unavailable/);
    f.tui.terminal.rows = 18;
    assert.match(f.text(100), /Graph unavailable or too large; showing list/);
    assert.match(f.text(100), /#1 Task 1/);
  } finally { f.close(); await f.running; }
});

test("focus navigation keeps the selected task fixed and styles all three section headers", async () => {
  const data = snapshot();
  data.tasks = Array.from({ length: 40 }, (_, i) => task(`T${i + 1}`, {
    title: i === 1 ? "Long wrapping prerequisite title for a stable focus anchor" : `Work ${i + 1}`,
    dependencies: i ? Array.from({ length: Math.min(i, 3) }, (_, j) => `T${i - j}`) : [],
  }));
  const f = await panelFixture(data, { graph: true });
  try {
    f.tui.terminal.rows = 44;
    const anchor = (number: number) => {
      const lines = f.component.render(100);
      const row = lines.findIndex(line => cleanText(line).includes(`● #${number} `));
      assert.ok(row >= 0);
      for (const header of ["Prerequisites", "Focused task", "Dependents"]) {
        const line = lines.find(line => line.includes(header));
        assert.ok(line?.includes("\x1b[95m"), `${header} needs the existing purple accent`);
        assert.ok(cleanText(line!).includes("─"), `${header} needs a divider`);
      }
      return row;
    };
    const initial = anchor(1);
    for (let i = 2; i <= 6; i++) { f.component.handleInput("\x1b[C"); assert.equal(anchor(i), initial); }
    f.component.handleInput("\x1b[A"); assert.equal(anchor(5), initial);
    f.component.handleInput("\x1b[B"); assert.equal(anchor(6), initial);
    f.component.handleInput("\r"); f.component.handleInput("\x1b"); assert.equal(anchor(6), initial);
    f.tui.terminal.rows = 32;
    assert.ok(f.component.render(40).every(line => visibleWidth(line) <= 40));
  } finally { f.close(); await f.running; }
});

test("focused refresh retains the selected UUID and rebuilds changed relationships", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = snapshot();
  data.tasks = Array.from({ length: 40 }, (_, i) => task(`T${i + 1}`, {
    title: `Work ${i + 1}`, dependencies: i ? [`T${i}`] : [], blockedBy: i ? [`T${i}`] : [],
  }));
  const f = await panelFixture(data, { graph: true });
  try {
    f.text(100);
    f.component.handleInput("\x1b[B");
    assert.match(f.text(100), /● #2 Work 2/);
    f.host.snapshot = async () => ({ ...data, tasks: data.tasks.map(item => item.id === "T2" ? { ...item, dependencies: ["T4"], blockedBy: ["T4"] } : item.id === "T4" ? { ...item, dependencies: [], blockedBy: [] } : item).reverse() });
    t.mock.timers.tick(2000); await tick();
    const text = f.text(100);
    assert.match(text, /Focus: 3 of 40 tasks/);
    assert.match(text, /● #2 Work 2/);
    assert.match(text, /○ #4 Work 4/);
    assert.match(text, /○ #3 Work 3/);
    f.component.handleInput("\x1b[C");
    assert.match(f.text(100), /● #1 Work 1/, "horizontal navigation can reach an unrelated task in current list order");
  } finally { f.close(); await f.running; }
});

test("task graph starts fitted and zooms by shortening titles, never dropping number or status", async () => {
  const data = snapshot();
  data.tasks = ["a", "b", "c"].map((x, i) => task(`T${x}`, { number: i + 1, title: `Count lines in ${x}.txt` }));
  const f = await panelFixture(data, { graph: true });
  const graph = () => f.text(200);
  try {
    assert.match(graph(), /Zoom 100% \(fit\)/);
    assert.match(graph(), /#1 Count lines in a\.txt/);
    f.component.handleInput("-");
    assert.match(graph(), /Zoom \d+%(?! \(fit\))/);
    assert.match(graph(), /#1 Count lines in…/, "zooming out cuts at a word boundary with an ellipsis");
    for (let i = 0; i < 20; i++) f.component.handleInput("-");
    assert.match(graph(), /Zoom 0%/);
    assert.match(graph(), /#1 · Ready/, "number and status survive the smallest zoom");
    f.component.handleInput("\x1b[C");
    assert.match(f.text(200), /#2 Count lines in b\.txt · Ready/, "selection still moves at the smallest zoom");
    for (let i = 0; i < 20; i++) f.component.handleInput("+");
    assert.match(graph(), /Zoom 100%/);
    f.component.handleInput("f");
    assert.match(graph(), /\(fit\)/);
    assert.match(f.text(60), /Focus: 1 of 3 tasks/, "a narrow pane uses readable focus instead of hiding titles to claim a fit");
    assert.doesNotMatch(f.text(60), /\(fit\)/);
  } finally { f.close(); await f.running; }
});

test("panel formats only visible graph rows and reveals off-screen tasks on navigation", async t => {
  const data = snapshot();
  data.tasks = Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`, {
    title: `Task ${i + 1}`, dependencies: i ? [`T${i}`] : [],
  }));
  const f = await panelFixture(data, { graph: true });
  const fg = theme.fg.bind(theme);
  let formattedBottom = false, formattedRows = 0;
  t.mock.method(theme, "fg", (color: Parameters<Theme["fg"]>[0], text: string) => {
    if (text.includes("┌")) formattedRows++;
    if (text.includes("#30")) formattedBottom = true;
    return fg(color, text);
  });
  try {
    f.text(75);
    f.component.handleInput("a");
    f.component.invalidate();
    f.text(75);
    assert.equal(formattedBottom, false, "off-screen boxes must not be formatted");
    const firstPass = formattedRows;
    assert.ok(firstPass > 0);
    f.text(75);
    assert.equal(formattedRows, firstPass, "unchanged rows should reuse formatting");
    f.component.invalidate();
    f.text(75);
    assert.ok(formattedRows > firstPass, "theme invalidation must discard styled rows");
    for (let i = 1; i < 30; i++) f.component.handleInput("\x1b[B");
    assert.match(f.text(75), /● #30 Task 30 · Ready/);
    assert.equal(formattedBottom, true);
    f.component.handleInput("\x1b[A");
    assert.match(f.text(75), /● #29 Task 29 · Ready/);
    f.tui.terminal.rows = 50;
    assert.ok(f.component.render(120).every(line => visibleWidth(line) <= 120));
  } finally { f.close(); await f.running; }
});

test("feedback sends prose and task context without mutating task state", async () => {
  const data = snapshot();
  const before = JSON.stringify(data);
  const f = await panelFixture(data);
  const deliveries: { id: string; text: string }[] = [];
  try {
    f.host.feedback = async (selected, text) => { deliveries.push({ id: selected.id, text }); return "Receipt F1: feedback delivered"; };
    f.component.handleInput("c"); f.component.handleInput("Please clarify acceptance");
    f.component.handleInput("\x1b");
    assert.equal(f.host.drafts.get("feedback:T03"), "Please clarify acceptance");
    f.component.handleInput("c"); f.component.handleInput("\r"); await tick();
    assert.deepEqual(deliveries, [{ id: "T03", text: "Please clarify acceptance" }]);
    assert.match(f.text(), /Receipt F1: feedback delivered/);
    assert.equal(f.host.drafts.has("feedback:T03"), false);
    assert.equal(JSON.stringify(data), before);
  } finally { f.close(); await f.running; }
});
