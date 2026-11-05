import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTasks, projectFor, resolveLang, filterGroups, ago, shortId, linkParts, eventMarkdown, detailEvents, isBlocked, latestOnly,
  listRows, moveSelection, keyCommand, escapeStep, boardChanged, authorLabel, shownSelection, windowsView } from "./logic.js";

const task = (id, open_blockers = 0, waiting = null, active_at = 0) => ({ id, title: id, open_blockers, waiting, active_at });

test("groups run waiting on you, in progress, open with blocked tasks last and marked, then done", () => {
  const board = { columns: [
    { key: "open", tasks: [task("B1", 1), task("A"), task("B2", 2), task("C")] },
    { key: "in_progress", tasks: [task("P")] },
    { key: "done", tasks: [task("D")] },
  ] };
  const groups = groupTasks(board);
  assert.deepEqual(groups.map((g) => g.key), ["waiting", "in_progress", "open", "done"]);
  assert.deepEqual(groups[0].tasks, []);
  assert.deepEqual(groups[2].tasks.map((t) => [t.id, t.blocked]),
    [["A", false], ["C", false], ["B1", true], ["B2", true]]);
  assert.deepEqual(groups[1].tasks.map((t) => t.id), ["P"]);
  assert.deepEqual(groups[3].tasks.map((t) => t.id), ["D"]);
});

test("a task waiting on the user is listed only under waiting on you, latest activity first", () => {
  const board = { columns: [
    { key: "open", tasks: [task("A"), task("ASKED", 0, "which port?", 5)] },
    { key: "in_progress", tasks: [task("HELD", 0, "批准拆法吗？", 9), task("P")] },
    { key: "done", tasks: [task("D")] },
  ] };
  const ids = (gs) => gs.map((g) => [g.key, g.tasks.map((t) => t.id)]);
  assert.deepEqual(ids(groupTasks(board)),
    [["waiting", ["HELD", "ASKED"]], ["in_progress", ["P"]], ["open", ["A"]], ["done", ["D"]]]);
  // the CLI's `waiting` is null again once a later `triage: ready-for-agent` note ends the wait
  assert.deepEqual(ids(groupTasks({ columns: [{ key: "in_progress", tasks: [task("HELD", 0, null, 9)] }] })),
    [["waiting", []], ["in_progress", ["HELD"]], ["open", []], ["done", []]]);
});

test("a folder's project is its repository's main checkout name, when the board has that project", () => {
  const projects = { projects: [{ name: "nawaban" }, { name: "roubao" }] };
  // `git rev-parse --path-format=absolute --git-common-dir`, run in a worktree or the checkout
  assert.equal(projectFor("/Users/v/nawaban/.git\n", projects), "nawaban");
  assert.equal(projectFor("/Users/v/elsewhere/.git\n", projects), null);
  assert.equal(projectFor("", projects), null); // not in a git repository
});

test("the saved language wins, else the system's first preferred language: Chinese or English", () => {
  const apple = (...langs) => `(\n${langs.map((l) => `    "${l}"`).join(",\n")}\n)\n`; // defaults read -g AppleLanguages
  assert.equal(resolveLang(null, apple("zh-Hans-JP")), "zh");
  assert.equal(resolveLang(null, apple("en-US", "zh-Hans")), "en");
  assert.equal(resolveLang(null, apple("ja-JP")), "en");
  assert.equal(resolveLang(null, "zh_CN.UTF-8"), "zh"); // $LANG, off macOS
  assert.equal(resolveLang(null, ""), "en");
  assert.equal(resolveLang("en", apple("zh-Hans")), "en");
  assert.equal(resolveLang("zh", "en_US.UTF-8"), "zh");
  assert.equal(resolveLang("fr", "zh_CN.UTF-8"), "zh"); // an unknown saved value is ignored
});

test("the filter box matches ID or title", () => {
  const groups = groupTasks({ columns: [
    { key: "in_progress", tasks: [{ id: "NAWA-1", title: "Panel view" }] },
    { key: "open", tasks: [{ id: "NAWA-2", title: "Detail page", open_blockers: 1 }, { id: "NAWA-3", title: "Install docs" }] },
    { key: "done", tasks: [{ id: "OTHER-4", title: "panel data" }] },
  ] });
  const ids = (gs) => gs.map((g) => [g.key, g.tasks.map((t) => t.id)]);
  assert.deepEqual(ids(filterGroups(groups, "PANEL")), [["waiting", []], ["in_progress", ["NAWA-1"]], ["open", []], ["done", ["OTHER-4"]]]);
  assert.deepEqual(ids(filterGroups(groups, " nawa-3 ")), [["waiting", []], ["in_progress", []], ["open", ["NAWA-3"]], ["done", []]]);
  assert.deepEqual(ids(filterGroups(groups, "")),
    [["waiting", []], ["in_progress", ["NAWA-1"]], ["open", ["NAWA-3", "NAWA-2"]], ["done", ["OTHER-4"]]]);
});

test("times read as how long ago, in the panel's language", () => {
  const now = 1_000_000;
  assert.equal(ago(now - 20, now, "zh"), "刚刚");
  assert.equal(ago(now - 180, now, "zh"), "3 分钟前");
  assert.equal(ago(now - 180, now, "en"), "3m ago");
  assert.equal(ago(now - 2 * 3600, now, "en"), "2h ago");
  assert.equal(ago(now - 5 * 86400, now, "zh"), "5 天前");
});

test("a long ID keeps its head and its distinguishing tail, cut in the middle", () => {
  assert.equal(shortId("NAWABAN-HERDR-PANEL-03", 18), "NAWABAN-…-PANEL-03");
  assert.equal(shortId("NAWABAN-HERDR-PANEL-02", 18), "NAWABAN-…-PANEL-02");
  assert.equal(shortId("INTSTD-RESEARCH-OFFBOARD-PROPAGATION-001", 18), "INTSTD-R…ATION-001");
  assert.equal(shortId("NAWABAN-HERDR-PANEL", 18), "NAWABAN-…RDR-PANEL");
  assert.equal(shortId("LEAN-03", 18), "LEAN-03");
  assert.equal(shortId("EXACTLY-EIGHTEEN18", 18), "EXACTLY-EIGHTEEN18");
});

test("a link event reads as its kind, its value and a note; only http(s) values open", () => {
  assert.deepEqual(linkParts("pr:https://github.com/a/b/pull/42"),
    { kind: "pr", value: "https://github.com/a/b/pull/42", note: null, url: "https://github.com/a/b/pull/42" });
  assert.deepEqual(linkParts("pr: https://example.test/pull/1 · merged"),
    { kind: "pr", value: "https://example.test/pull/1", note: "merged", url: "https://example.test/pull/1" });
  assert.deepEqual(linkParts("https://example.test/a"),
    { kind: null, value: "https://example.test/a", note: null, url: "https://example.test/a" });
  assert.deepEqual(linkParts("commit:c4944fff64424170585455a345e2978086dd8aa1"),
    { kind: "commit", value: "c4944fff64424170585455a345e2978086dd8aa1", note: null, url: null });
  assert.deepEqual(linkParts("adr:docs/adr/0003-board.md"),
    { kind: "adr", value: "docs/adr/0003-board.md", note: null, url: null });
});

test("an open task is blocked while any task it waits on is not done or cancelled", () => {
  const ref = (status) => ({ id: status, title: status, status });
  assert.equal(isBlocked({ status: "open", blocked_by: [ref("done"), ref("in_progress")] }), true);
  assert.equal(isBlocked({ status: "open", blocked_by: [ref("open")] }), true);
  assert.equal(isBlocked({ status: "open", blocked_by: [ref("done"), ref("cancelled")] }), false);
  assert.equal(isBlocked({ status: "in_progress", blocked_by: [ref("open")] }), false);
  assert.equal(isBlocked({ status: "open", blocked_by: [] }), false);
});

test("an event body keeps its line breaks as markdown, a decision's labels in bold", () => {
  assert.equal(eventMarkdown("Question: A\nVerdict: B\nRejected: C"), "**Question:** A  \n**Verdict:** B  \n**Rejected:** C");
  assert.equal(eventMarkdown("question: A\nsee Verdict: no"), "**question:** A  \nsee Verdict: no"); // migrated, lower case
});

test("the detail's event stream holds notes, decisions and links, newest first, without status changes", () => {
  const ev = (kind, at) => ({ kind, body: kind, author: "s", at });
  const events = [ev("status", 5), ev("note", 4), ev("link", 3), ev("decision", 2), ev("status", 1)];
  assert.deepEqual(detailEvents(events).map((e) => e.kind), ["note", "link", "decision"]);
  assert.deepEqual(detailEvents(undefined), []);
});

test("only the latest request's answer counts, whatever order the answers arrive in", () => {
  const ticket = latestOnly();
  const first = ticket(), second = ticket();
  assert.equal(first(), false);
  assert.equal(second(), true);
});

const keys = (rows) => rows.map((r) => r.key);
const board3 = () => groupTasks({ columns: [
  { key: "in_progress", tasks: [task("P")] },
  { key: "open", tasks: [task("A"), task("B"), task("C"), task("X", 1)] },
  { key: "done", tasks: [task("D")] },
] });

test("the list is one run of rows: each group's heading, then every one of its tasks", () => {
  assert.deepEqual(keys(listRows(board3())),
    ["head:in_progress", "task:P", "head:open", "task:A", "task:B", "task:C", "task:X", "head:done", "task:D"]);
  assert.deepEqual(keys(listRows(filterGroups(board3(), "x"))), ["head:open", "task:X"]); // filtered
});

test("a group with no tasks takes no heading", () => {
  const groups = groupTasks({ columns: [{ key: "open", tasks: [task("A")] }, { key: "done", tasks: [task("D")] }] });
  assert.deepEqual(keys(listRows(groups)), ["head:open", "task:A", "head:done", "task:D"]); // no "in progress 0"
});

test("the arrow keys move the selection from task to task, past the headings, and stop at either end", () => {
  const rows = listRows(board3());
  assert.equal(moveSelection(rows, null, 1), "task:P"); // nothing picked yet: down starts at the top
  assert.equal(moveSelection(rows, null, -1), "task:D"); // and up at the bottom
  assert.equal(moveSelection(rows, "task:P", 1), "task:A");
  assert.equal(moveSelection(rows, "task:A", -1), "task:P");
  assert.equal(moveSelection(rows, "task:D", 1), "task:D");
  assert.equal(moveSelection(rows, "task:P", -1), "task:P");
  assert.equal(moveSelection(rows, "task:GONE", 1), "task:P"); // a row that left the list
  assert.equal(moveSelection([], null, 1), null);
});

test("keys become the panel's commands: arrows move, Enter opens, Esc goes back, / filters", () => {
  const press = (keystroke, key_char) => keyCommand({ keystroke, key: keystroke, key_char });
  assert.equal(press("down"), "down");
  assert.equal(press("up"), "up");
  assert.equal(press("enter"), "open");
  assert.equal(press("escape"), "back");
  assert.equal(press("/", "/"), "filter");
  assert.equal(press("shift-7", "/"), "filter"); // a layout where / needs shift
  assert.equal(press("cmd-down"), null); // chords stay Herdr's
  assert.equal(press("a", "a"), null);
});

test("Esc steps back one layer: the task shown, then the filter box, then the filter's text", () => {
  assert.equal(escapeStep({ trail: ["A"], inFilter: false, query: "x" }), "pop");
  assert.equal(escapeStep({ trail: [], inFilter: true, query: "x" }), "leave-filter");
  assert.equal(escapeStep({ trail: [], inFilter: false, query: " x " }), "clear-filter");
  assert.equal(escapeStep({ trail: [], inFilter: false, query: "  " }), null);
});

test("a change under the board's folder counts when it is the board or its write-ahead log", () => {
  const db = "/u/.nawaban/nawaban.db";
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db-wal"], db), true);
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db"], db), true);
  assert.equal(boardChanged(["/u/.nawaban"], db), true); // the watched folder itself: anything may have changed
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db-shm"], db), false); // readers, the panel too, touch this
  assert.equal(boardChanged(["/u/.nawaban/backups/nawaban-1.db", "/u/.nawaban/nawaban.old.db"], db), false);
  assert.equal(boardChanged([], db), false);
});

test("an event's author reads as you for the user's own decisions, else agent", () => {
  assert.equal(authorLabel("user", "zh"), "你");
  assert.equal(authorLabel("user", "en"), "You");
  assert.equal(authorLabel("76ecefa7-ecd3-4558-9567-badac0af274c", "zh"), "agent");
  assert.equal(authorLabel(null, "en"), "agent");
});

test("a selection that the filter, a refresh or another project hid is no selection", () => {
  const rows = [{ key: "head:open", kind: "head" }, { key: "task:B", kind: "task" }];
  assert.equal(shownSelection(rows, "task:A"), null);
  assert.equal(shownSelection(rows, "task:B"), "task:B");
  assert.equal(shownSelection(rows, null), null);
});

// Herdr agents (AgentInfo) and `nawaban json board` tasks, as windowsView reads them.
const agent = (address, status, title, tab_name = "", seq = 0) => ({ address, pane: `p-${address}`, status, title, tab_name, seq });
const held = (id, terminal, { status = "in_progress", waiting = null, active_at = 0, title = id } = {}) =>
  ({ id, title, status, terminal, waiting, session: null, active_at });
const boardOf = (...tasks) => ({ columns: ["open", "in_progress", "done"].map((key) => ({ key, tasks: tasks.filter((t) => t.status === key) })) });
const NOW = 100000;
const view = (agents, tasks = [], extra = {}) => windowsView({ agents, board: boardOf(...tasks), now: NOW, lang: "zh", ...extra });

test("a working window with no task is 在干 on its terminal title, named by its tab", () => {
  const v = view([agent("t1", "working", "读 CRM 字段", "分析 CRM")]);
  assert.deepEqual(v.rows, [{ name: "分析 CRM", doing: "读 CRM 字段", state: "working", label: "在干", duration: null, focus: "t1" }]);
  assert.deepEqual(v.waiting, []);
  assert.deepEqual(v.idle, { count: 0, names: [] });
});

test("an idle window holding an open task is 停了 on that task, for as long as since its latest event", () => {
  const tasks = [held("A", "t1", { title: "解析 Frontmatter", active_at: NOW - 3 * 3600 }), held("B", "elsewhere")];
  const v = view([agent("t1", "idle", "zsh", "解析")], tasks);
  assert.deepEqual(v.rows, [{ name: "解析", doing: "解析 Frontmatter", state: "stopped", label: "停了", duration: "3h", focus: "t1" }]);
  assert.equal(view([agent("t1", "idle", "zsh", "解析")], tasks, { lang: "en" }).rows[0].label, "Stopped");
});

test("a window that finished unseen is 完成; one idle with no open task is 空闲, collapsed into the idle row", () => {
  const tasks = [held("OLD", "t2", { status: "done" })];
  const v = view([agent("t1", "done", "知识库重试", "13"), agent("t2", "idle", "zsh", "7"), agent("t3", "idle", "~", "")], tasks);
  assert.deepEqual(v.rows.map((r) => [r.name, r.doing, r.state, r.label]), [["13", "知识库重试", "done", "完成"]]);
  assert.deepEqual(v.idle, { count: 2, names: ["7", "~"] });
});

test("rows run 停了, then 完成, then 在干, the window Herdr changed most recently first within each", () => {
  const tasks = [held("S1", "s1"), held("S2", "s2")];
  const v = view([agent("w1", "working", "w1", "", 5), agent("d1", "done", "d1", "", 1), agent("s1", "idle", "s1", "", 2),
    agent("w2", "working", "w2", "", 9), agent("s2", "idle", "s2", "", 7)], tasks);
  assert.deepEqual(v.rows.map((r) => r.focus), ["s2", "s1", "d1", "w2", "w1"]);
});

test("a window holding a task that asks a triage question is 等你: a card with the question, out of the table", () => {
  const tasks = [held("Q", "t1", { title: "日报同步", waiting: "要放行吗？", active_at: NOW - 3600 })];
  const v = view([agent("t1", "working", "claude", "清理flag")], tasks);
  assert.deepEqual(v.waiting, [{ name: "清理flag", question: "要放行吗？", doing: "日报同步", state: "waiting", label: "等你",
    duration: "1 小时", focus: "t1" }]);
  assert.deepEqual(v.rows, []);
  assert.equal(view([agent("t1", "working", "claude", "清理flag")], tasks, { lang: "en" }).waiting[0].duration, "1h");
});

test("a window Herdr reports blocked is 等你 on its terminal title, asking for a confirmation, for no known time", () => {
  const v = view([agent("t1", "blocked", "rm -rf build?", "")]);
  assert.deepEqual(v.waiting, [{ name: "rm -rf build?", question: "在等你确认", doing: "rm -rf build?", state: "waiting",
    label: "等你", duration: null, focus: "t1" }]);
  assert.deepEqual(v.rows, []);
  assert.equal(view([agent("t1", "blocked", "x")], [], { lang: "en" }).waiting[0].question, "Waiting for you to confirm");
  // the terminal title says what it asks to confirm, so it stays on the card when the window holds a task
  const card = view([agent("t1", "blocked", "rm -rf build?", "清理flag")], [held("A", "t1", { title: "清理" })]).waiting[0];
  assert.deepEqual([card.name, card.doing, card.duration], ["清理flag", "rm -rf build?", null]);
});

test("a waiting task in no window of this space still gets a card, with nothing to focus; cards wait longest first", () => {
  const tasks = [held("NOWHERE", null, { status: "open", title: "补文档", waiting: "哪个目录？", active_at: NOW - 600 }),
    held("AWAY", "other-space", { title: "上传", waiting: "能上 prod 吗？", active_at: NOW - 2 * 86400 }),
    held("HERE", "t1", { title: "同步", waiting: "放行吗？", active_at: NOW - 3600 })];
  const v = view([agent("t1", "working", "claude", "清理flag"), agent("t2", "blocked", "确认删除？", "", 3)], tasks);
  assert.deepEqual(v.waiting.map((c) => [c.name, c.question, c.doing, c.duration, c.focus]), [
    ["AWAY", "能上 prod 吗？", "上传", "2 天", null],
    ["清理flag", "放行吗？", "同步", "1 小时", "t1"],
    ["NOWHERE", "哪个目录？", "补文档", "10 分钟", null],
    ["确认删除？", "在等你确认", "确认删除？", null, "t2"]]);
});

test("the header counts what waits on you in the other projects of `json projects`", () => {
  const projects = { projects: [{ name: "nawaban", waiting: 4 }, { name: "roubao", waiting: 2 }, { name: "huafa", waiting: 1 }] };
  assert.equal(view([], [], { projects, project: "nawaban" }).otherWaiting, 3);
  assert.equal(view([]).otherWaiting, 0);
});
