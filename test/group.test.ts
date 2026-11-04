import test from "node:test";
import assert from "node:assert/strict";
import { groupTeamRows } from "../src/group.ts";

const labels = { root: "Main", m1: "count-a", t1: "#1 Count lines in a.txt", t2: "#2 Count lines in b.txt" };
const notice = (posts: object[], expanded = false) => ({ message: { customType: "ac-teams", details: { messages: posts } }, _expanded: expanded, render: () => ["notice"] });
const tool = (toolName: string, args: object, expanded = false) => ({ toolName, args, expanded, render: () => [`${toolName}`] });
const other = (text: string) => ({ render: () => [text] });
const empty = { render: () => [] };
const draw = (children: unknown[]) => groupTeamRows(children, 80, (header, posts, _width, warnings) => [`[${header}]`, ...warnings, ...posts], labels, "Main", line => line.startsWith("Warning: Host")).flatMap(child => (child as { render(width: number): string[] }).render(80));

test("a run of team rows folds into plain words: what Main did, then each post", () => {
  const rows = [
    tool("team_task", { action: "list" }), tool("team_task", { action: "create", tasks: [{ title: "Count a" }, { title: "Count b" }] }),
    tool("team_agent", { action: "launch", name: "count-a" }), empty, tool("team_agent", { action: "launch", name: "count-b" }),
    tool("team_message", { action: "wait", tasks: ["t1", "t2"] }),
    notice([{ from: "m1", task: "t1", kind: "outcome", summary: "37 lines\nmore" }]),
  ];
  assert.deepEqual(draw(rows), ["", '[working · created 2 tasks · launched count-a, count-b · waiting on #1, #2 · 1 completed]', "count-a completed #1 Count lines in a.txt (woke Main): 37 lines"]);
});

test("any visible other row ends a run, so later rows never join an older block", () => {
  const a = notice([{ from: "m1", summary: "Question?", task: "t1" }]);
  assert.deepEqual(draw([a, a, other("text"), a, tool("read", {})]), ["", "[working · 2 updates]", "count-a → #1 Count lines in a.txt: Question?", "count-a → #1 Count lines in a.txt: Question?", "text", "notice", "read"]);
  assert.deepEqual(draw([a, empty]), ["notice"], "a single team row stays native; a trailing empty row is not swallowed");
});

test("an expanded row shows its whole run natively, and silenced notices draw nothing", () => {
  assert.deepEqual(draw([tool("team_task", { action: "list" }, true), notice([])]), ["team_task", "notice"]);
  const silent = { message: { customType: "ac-teams" }, render: () => [] };
  assert.deepEqual(draw([silent, silent]), []);
});

test("the status word follows the transcript: waiting after a wait, done once every watched task completes", () => {
  const wait = tool("team_message", { action: "wait", tasks: ["t1", "t2"] });
  const done = (task: string) => notice([{ from: "m1", task, kind: "outcome", summary: "ok" }]);
  assert.deepEqual(draw([tool("team_agent", { action: "launch", name: "count-a" }), wait, other("Turn took 3s"), done("t1"), wait, other("Turn took 1s"), done("t2"), done("t1")]), [
    "", "[waiting · launched count-a · waiting on #1, #2]", "Turn took 3s",
    "", "[waiting · waiting on #1, #2 · 1 completed]", "count-a completed #1 Count lines in a.txt (woke Main): ok", "Turn took 1s",
    "", "[done · 2 completed]", "count-a completed #2 Count lines in b.txt (woke Main): ok", "count-a completed #1 Count lines in a.txt: ok",
  ]);
});

test("a user message ends the yield, so the next post is not credited with waking the session", () => {
  class UserMessageComponent { render() { return ["hi"]; } }
  const wait = tool("team_message", { action: "wait", tasks: ["t1"] });
  const post = notice([{ from: "m1", task: "t1", summary: "Question?" }]);
  assert.deepEqual(draw([wait, new UserMessageComponent(), post]).at(-1), "notice");
  assert.ok(!draw([tool("team_agent", { action: "launch", name: "x" }), wait, new UserMessageComponent(), post, post]).some(line => line.includes("woke")));
});

test("spacers and ac-teams' own warnings between team rows stay inside the block, shown once", () => {
  const spacer = { render: () => [""] }, warning = { render: () => ["\x1b[33mWarning: Host memory\x1b[0m"] };
  const launch = (name: string) => tool("team_agent", { action: "launch", name });
  assert.deepEqual(draw([launch("a"), spacer, warning, launch("b"), warning, launch("c"), warning]), ["", "[working · launched a, b, c]", "Warning: Host memory", "\x1b[33mWarning: Host memory\x1b[0m"]);
  assert.deepEqual(draw([launch("a"), { render: () => ["Warning: something else"] }, launch("b")]), ["team_agent", "Warning: something else", "team_agent"], "other warnings still end a run");
});
