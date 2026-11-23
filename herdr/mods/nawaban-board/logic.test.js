import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFor, cliFor, BOARD_PROJECTS, resolveLang, moveSelection, keyCommand, boardChanged, windowsView, panelView, sinceLabel, decisionDate, WINDOW_WORDS,
  okrView, OKR_WORDS, gapOf, varianceText, decisionCardsView, TO_ORCHESTRATOR, marksStillToKeep, repoRootOf, TASK_GROUPS, taskSections, panelKeys, foldKey, isGroupOpen, groupOfKey, GROUP_OPEN_BY_DEFAULT, ROWS_SHOWN_PER_GROUP, moreKey, TABS, openingTab, tabBadges } from "./logic.js";
import { readFileSync } from "node:fs";

test("a folder's project is its repository's main checkout name, when the board has that project", () => {
  const projects = { projects: [{ name: "nawaban" }, { name: "roubao" }] };
  assert.equal(projectFor("/Users/v/nawaban/.git\n", projects), "nawaban");
  assert.equal(projectFor("/Users/v/elsewhere/.git\n", projects), null);
  assert.equal(projectFor("", projects), null);
});

test("while both boards run, a project is read from the board only once it moved there, and only on this computer", () => {
  assert.deepEqual([...BOARD_PROJECTS].sort(), ["bzkanbanv2", "huafa", "nawaban"]);
  assert.equal(cliFor("nawaban"), "board");
  assert.equal(cliFor("roubao"), "old");
  assert.equal(cliFor("agent-center"), "old");
  assert.equal(cliFor(null), "old");
  assert.equal(cliFor("nawaban", "mbp"), "old");
});

test("BOARD_PROJECTS stays the one line of JSON strings nawaban/cli.py reads to refuse writes", () => {
  const cliPyReads = /^export const BOARD_PROJECTS = new Set\((\[[^\]\n]*\])?\);$/m;
  const line = readFileSync(new URL("./logic.js", import.meta.url), "utf8").match(cliPyReads);
  assert.deepEqual(JSON.parse(line[1]).sort(), [...BOARD_PROJECTS].sort());
});

test("the saved language wins, else the system's first preferred language: Chinese or English", () => {
  const apple = (...langs) => `(\n${langs.map((l) => `    "${l}"`).join(",\n")}\n)\n`;
  assert.equal(resolveLang(null, apple("zh-Hans-JP")), "zh");
  assert.equal(resolveLang(null, apple("en-US", "zh-Hans")), "en");
  assert.equal(resolveLang(null, apple("ja-JP")), "en");
  assert.equal(resolveLang(null, "zh_CN.UTF-8"), "zh");
  assert.equal(resolveLang(null, ""), "en");
  assert.equal(resolveLang("en", apple("zh-Hans")), "en");
  assert.equal(resolveLang("zh", "en_US.UTF-8"), "zh");
  assert.equal(resolveLang("fr", "zh_CN.UTF-8"), "zh");
});

test("the arrow keys move the selection through cards and rows together, and stop at either end", () => {
  const keys = ["card", "row1", "row2"];
  assert.equal(moveSelection(keys, null, 1), "card");
  assert.equal(moveSelection(keys, null, -1), "row2");
  assert.equal(moveSelection(keys, "card", 1), "row1");
  assert.equal(moveSelection(keys, "row1", -1), "card");
  assert.equal(moveSelection(keys, "row2", 1), "row2");
  assert.equal(moveSelection(keys, "card", -1), "card");
  assert.equal(moveSelection(keys, "GONE", 1), "card");
  assert.equal(moveSelection([], null, 1), null);
});

test("keys become the panel's commands: arrows move, Enter goes to the window, Esc goes back", () => {
  const press = (keystroke, key_char) => keyCommand({ keystroke, key: keystroke, key_char });
  assert.equal(press("down"), "down");
  assert.equal(press("up"), "up");
  assert.equal(press("enter"), "open");
  assert.equal(press("escape"), "back");
  assert.equal(press("/", "/"), null);
  assert.equal(press("cmd-down"), null);
  assert.equal(press("a", "a"), null);
});

test("a change under the board's folder counts when it is the board or its write-ahead log", () => {
  const db = "/u/.nawaban/nawaban.db";
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db-wal"], db), true);
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db"], db), true);
  assert.equal(boardChanged(["/u/.nawaban"], db), true);
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db-shm"], db), false);
  assert.equal(boardChanged(["/u/.nawaban/backups/nawaban-1.db", "/u/.nawaban/nawaban.old.db"], db), false);
  assert.equal(boardChanged([], db), false);
});

const agent = (address, status, title, tab_name = "", seq = 0, space = "here") => ({ address, pane: `p-${address}`, status, title, tab_name, seq, space });
const held = (id, terminal, { status = "in_progress", waiting = null, active_at = 0, title = id } = {}) =>
  ({ id, title, status, terminal, waiting, session: null, active_at });
const boardOf = (...tasks) => ({ columns: ["open", "in_progress", "done"].map((key) => ({ key, tasks: tasks.filter((t) => t.status === key) })) });
const NOW = 100000;
const view = (agents, tasks = [], extra = {}) => windowsView({ agents, space: "here", board: boardOf(...tasks), now: NOW, lang: "zh", ...extra });

test("a working window with no task is 在干 on its terminal title, named by its tab", () => {
  const v = view([agent("t1", "working", "读 CRM 字段", "分析 CRM")]);
  assert.deepEqual(v.rows, [{ name: "分析 CRM", doing: "读 CRM 字段", state: "working", label: "在干", duration: null, focus: "t1" }]);
  assert.deepEqual(v.waiting, []);
  assert.deepEqual(v.idle, { count: 0, names: [] });
});

test("an idle window holding an open task is 停滞 on that task, for as long as since its latest event", () => {
  const tasks = [held("A", "t1", { title: "解析 Frontmatter", active_at: NOW - 3 * 3600 }), held("B", "elsewhere")];
  const v = view([agent("t1", "idle", "zsh", "解析")], tasks);
  assert.deepEqual(v.rows, [{ name: "解析", doing: "解析 Frontmatter", state: "stopped", label: "停滞", duration: "3h", focus: "t1" }]);
  assert.equal(view([agent("t1", "idle", "zsh", "解析")], tasks, { lang: "en" }).rows[0].label, "Stale");
});

test("a window that finished unseen is 已完成; one idle with no open task is 空闲, collapsed into the idle row", () => {
  const tasks = [held("OLD", "t2", { status: "done" })];
  const v = view([agent("t1", "done", "知识库重试", "13"), agent("t2", "idle", "zsh", "7"), agent("t3", "idle", "~", "")], tasks);
  assert.deepEqual(v.rows.map((r) => [r.name, r.doing, r.state, r.label]), [["知识库重试", "知识库重试", "done", "已完成"]]);
  assert.deepEqual(v.idle, { count: 2, names: ["zsh", "~"] });
});

test("a window is named by its Herdr terminal name first, then its tab's name, then its terminal title", () => {
  const agents = [agent("t1", "working", "读字段", "分析 CRM"), agent("t2", "working", "读字段", "4"), agent("t3", "working", "读字段", "")];
  const terminals = [{ address: "t1", name: "gh-239", state: "live" }, { address: "t2", name: "gh-256", state: "live" }];
  assert.deepEqual(view(agents, [], { terminals }).rows.map((r) => r.name), ["gh-239", "gh-256", "读字段"]);
});

test("rows run 停滞, then 已完成, then 在干, the window Herdr changed most recently first within each", () => {
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
  const card = view([agent("t1", "blocked", "rm -rf build?", "清理flag")], [held("A", "t1", { title: "清理" })]).waiting[0];
  assert.deepEqual([card.name, card.doing, card.duration], ["清理flag", "rm -rf build?", null]);
});

test("a waiting task in no window of this space still gets a card: it focuses its terminal in another space, nothing when unknown; cards wait longest first", () => {
  const tasks = [held("NOWHERE", null, { status: "open", title: "补文档", waiting: "哪个目录？", active_at: NOW - 600 }),
    held("AWAY", "o1", { title: "上传", waiting: "能上 prod 吗？", active_at: NOW - 2 * 86400 }),
    held("GONE", "closed", { title: "清缓存", waiting: "清哪个？", active_at: NOW - 300 }),
    held("HERE", "t1", { title: "同步", waiting: "放行吗？", active_at: NOW - 3600 })];
  const v = view([agent("t1", "working", "claude", "清理flag"), agent("t2", "blocked", "确认删除？", "", 3),
    agent("o1", "working", "claude", "上传窗", 0, "other"), agent("o2", "blocked", "别处确认？", "", 4, "other")], tasks);
  assert.deepEqual(v.waiting.map((c) => [c.name, c.question, c.doing, c.duration, c.focus]), [
    ["上传窗", "能上 prod 吗？", "上传", "2 天", "o1"],
    ["清理flag", "放行吗？", "同步", "1 小时", "t1"],
    ["NOWHERE", "哪个目录？", "补文档", "10 分钟", null],
    ["GONE", "清哪个？", "清缓存", "5 分钟", null],
    ["确认删除？", "在等你确认", "确认删除？", null, "t2"]]);
  assert.deepEqual(v.rows.map((r) => r.focus), []);
  assert.deepEqual(v.idle, { count: 0, names: [] });
});

test("the header counts what waits on you in the other projects of `json projects`", () => {
  const projects = { projects: [{ name: "nawaban", waiting: 4 }, { name: "roubao", waiting: 2 }, { name: "huafa", waiting: 1 }] };
  assert.equal(view([], [], { projects, project: "nawaban" }).otherWaiting, 3);
  assert.equal(view([]).otherWaiting, 0);
});

const task = (id, { status = "open", session = null, leader = session, terminal = null, parent = null, created_at = 0,
  claimed_at = null, active_at = 0, done_at = null, progress = null, blocked_by = [], title = id } = {}) =>
  status === "done"
    ? { id, title, status, parent, session, created_at, active_at, terminal, leader, claimed_at, done_at }
    : { id, title, status, parent, session, created_at, active_at, terminal, leader, claimed_at,
      progress: progress && { body: progress, at: active_at }, blocked_by, waiting: null };
const panel = (agents, tasks, extra = {}) =>
  panelView({ agents, space: "here", board: boardOf(...tasks), now: NOW, lang: "zh", ...extra });
const grouped = (v) => v.tasks.map((g) => [g.group, g.items.map((i) => i.id)]);

test("every root task of the board is listed under 停滞, 进行中, 待办 or 已完成, in that order, whoever leads it and however long ago it was done", () => {
  const v = panel([agent("t1", "working", "claude", "入职"), agent("t2", "idle", "zsh", "闲")], [
    task("DONE-OLD", { status: "done", claimed_at: 1, done_at: NOW - 30 * 24 * 3600 }),
    task("TODO", { created_at: 4 }),
    task("WORKING", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 10, active_at: 10 }),
    task("IDLE", { status: "in_progress", session: "L", terminal: "t2", claimed_at: 5, active_at: NOW - 7200 }),
    task("GONE", { status: "in_progress", session: "W", terminal: "closed", claimed_at: 2, progress: "handoff" }),
    task("NO-TERMINAL", { status: "in_progress", session: "W3", claimed_at: 4 })]);
  assert.deepEqual(grouped(v), [["stopped", ["IDLE", "GONE"]], ["working", ["WORKING", "NO-TERMINAL"]], ["todo", ["TODO"]], ["done", ["DONE-OLD"]]]);
  const at = (id) => v.tasks.flatMap((g) => g.items).find((i) => i.id === id);
  assert.deepEqual([at("IDLE").focus, at("IDLE").where, at("IDLE").at, at("IDLE").gone], ["t2", "闲", NOW - 7200, false]);
  assert.deepEqual([at("GONE").focus, at("GONE").gone, at("GONE").note], [null, true, "handoff"]);
  assert.deepEqual([at("WORKING").key, at("WORKING").where, at("WORKING").at], ["task:WORKING", "入职", 10]);
  assert.deepEqual(panel([], []).tasks, []);
});

test("已完成 runs newest first; the other groups put the task that moved last first", () => {
  const v = panel([], [
    task("D1", { status: "done", done_at: NOW - 300 }), task("D2", { status: "done", done_at: NOW - 60 }), task("D3", { status: "done", done_at: NOW - 900 }),
    task("A", { status: "in_progress", session: "x", claimed_at: 1, active_at: 100 }),
    task("B", { status: "in_progress", session: "x", claimed_at: 1, active_at: 300 })]);
  assert.deepEqual(grouped(v), [["working", ["B", "A"]], ["done", ["D2", "D1", "D3"]]]);
});

test("a spec is one item: the ticket that needs you, else the one at work, speaks for it; done/total of its tickets", () => {
  const v = panel([agent("t2", "working", "claude", "w")], [
    task("S-03", { parent: "S", blocked_by: ["S-02"], created_at: 3 }),
    task("S-02", { parent: "S", status: "in_progress", session: "W", terminal: "t2", claimed_at: 20, progress: "第 3 张" }),
    task("S-01", { parent: "S", status: "done", claimed_at: 10, done_at: NOW - 3600 }),
    task("S", { title: "报表迁到新底座" })]);
  assert.deepEqual(grouped(v), [["working", ["S"]]]);
  const spec = v.tasks[0].items[0];
  assert.deepEqual([spec.title, spec.state, spec.note, spec.focus, spec.at, spec.spec], ["报表迁到新底座", "current", "第 3 张", "t2", 20, { done: 1, total: 3 }]);
  const done = panel([], [task("T-1", { parent: "T", status: "done", done_at: NOW - 60 }), task("T")]);
  assert.deepEqual(grouped(done), [["done", ["T"]]]);
});

test("what already has a card under 待决 is not listed again; a window waiting in another space stays under 停滞", () => {
  const asking = { ...task("Q", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 1 }), waiting: "放行吗？" };
  const v = panel([agent("t1", "working", "claude", "入职"), agent("t2", "blocked", "rm?", "确认"), agent("o1", "blocked", "rm?", "别处", 0, "other")], [asking,
    task("B", { status: "in_progress", session: "L", terminal: "t2", claimed_at: 2 }),
    task("X", { status: "in_progress", session: "L", terminal: "o1", claimed_at: 3, active_at: NOW - 60 })]);
  assert.deepEqual(v.waiting.map((c) => [c.key, c.focus]), [["card:0", "t1"], ["card:1", "t2"]]);
  assert.deepEqual(grouped(v), [["stopped", ["X"]]]);
  assert.equal(v.tasks[0].items[0].state, "waiting");
});

test("two tasks asking in one window: the one on the card is not listed again, the other stays under 停滞", () => {
  const ask = (id, active_at) => ({ ...task(id, { status: "in_progress", session: "L", terminal: "t1", claimed_at: 1, active_at }), waiting: id + "？" });
  const v = panel([agent("t1", "idle", "claude", "入职")], [ask("A", 10), ask("B", 20)]);
  assert.deepEqual(v.waiting.map((c) => c.question), ["B？"]);
  assert.deepEqual(grouped(v), [["stopped", ["A"]]]);
  assert.equal(v.tasks[0].items[0].state, "waiting");
});

test("an item says since when on the right: a done one its time of day today, else yesterday or its date; the others for how long", () => {
  const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime() / 1000;
  const now = at(6, 12, 0);
  const label = (state, when, lang = "zh") => sinceLabel({ state, at: when }, now, lang);
  assert.equal(label("done", at(6, 9, 10)), "09:10");
  assert.equal(label("done", at(5, 18, 40)), "昨天");
  assert.equal(label("done", at(4, 18, 40)), "11-04");
  assert.equal(label("done", at(5, 18, 40), "en"), "yesterday");
  assert.equal(label("current", now - 40 * 60), "40 分钟");
  assert.equal(label("current", now - 30), "刚刚");
  assert.equal(label("stopped", now - 2 * 3600 - 59), "2 小时");
  assert.equal(label("stopped", now - 2 * 3600, "en"), "2h");
  assert.equal(label("todo", null), "");
  assert.equal(decisionDate(at(5, 23, 59)), "11-05");
});

const kid = (address, name, status, parent = "t23") => ({ address, name, parent, status, state: "live" });
const issue = (n, x = {}) => ({ ...task(`#${n}`, { title: `issue ${n}`, ...x }), ...(x.waiting && { waiting: x.waiting }), url: `https://github.com/o/r/issues/${n}` });
const github = (...tasks) => ({ tracker: "github", ...boardOf(...tasks) });
const ghTree = [{ address: "t23", name: null, parent: null, status: "working", state: "live" },
  kid("t4a", "gh-275", "working"), kid("t4c", "gh-238r", "idle"), kid("t4d", "gh-239", "done"), kid("t4g", "plump", "idle")];
const ghIssues = [
  issue(275, { status: "in_progress", session: "gh-275（hc t52）", terminal: "t52", claimed_at: NOW - 3600, active_at: NOW - 600, progress: "第 2 步" }),
  issue(264, { active_at: NOW - 26 * 3600 }),
  issue(238, { status: "in_progress", session: "1dfeb4dd", claimed_at: NOW - 9000, active_at: NOW - 2 * 3600, progress: "等判官放行" }),
  issue(292, { active_at: NOW - 3600, waiting: "等负责人审 ADR 0030" }),
  issue(307, { status: "in_progress", session: "rel", terminal: "t4g", claimed_at: NOW - 7200, active_at: NOW - 30 * 3600 }),
  issue(239, { status: "done", done_at: NOW - 3600 })];
const ghView = (extra = {}) => panel([agent("t23", "working", "claude", "leader agent")], ghIssues, { terminals: ghTree, board: github(...ghIssues), ...extra });

test("on a GitHub board every issue is listed: unclaimed is 待办, 在干 or 进行中 is 进行中, quiet a day or needs-info is 停滞, closed is 已完成", () => {
  const v = ghView();
  assert.deepEqual(grouped(v), [["stopped", ["#292", "#307"]], ["working", ["#275", "#238"]], ["todo", ["#264"]], ["done", ["#239"]]]);
  const at = (id) => v.tasks.flatMap((g) => g.items).find((i) => i.id === id);
  assert.deepEqual([at("#275").state, at("#275").focus, at("#275").where, at("#275").note, at("#275").url],
    ["current", "t4a", "gh-275", "第 2 步", "https://github.com/o/r/issues/275"]);
  assert.deepEqual([at("#238").state, at("#238").focus], ["pushing", "t4c"]);
  assert.deepEqual([at("#307").state, at("#307").focus, at("#307").where], ["stopped", "t4g", "plump"]);
  assert.deepEqual([at("#264").at, at("#264").focus], [null, null]);
  assert.deepEqual([at("#239").focus, at("#239").at], ["t4d", NOW - 3600]);
  assert.deepEqual(v.waiting, []);
});

test("on a GitHub board a claim's terminal comes before a gh-<n> name", () => {
  const tree = [ghTree[0], kid("t4c", "gh-238r", "working")];
  const tasks = [issue(238, { title: "named" }), issue(301, { status: "in_progress", session: "x", terminal: "t4c", claimed_at: NOW - 60, title: "claimed" })];
  const v = panel([agent("t23", "working", "claude", "leader agent")], tasks, { terminals: tree, board: github(...tasks) });
  assert.deepEqual(v.tasks.map((g) => [g.group, g.items.map((i) => [i.title, i.focus])]), [["working", [["claimed", "t4c"]]], ["todo", [["named", null]]]]);
});

test("on a GitHub board a window Herdr reports blocked is still a 等你 card (GLOSSARY: Waiting on you), a worker with no pane too, its issue closed or not, and not listed again", () => {
  const terminals = ghTree.map((k) => (k.address === "t4c" || k.address === "t4d" ? { ...k, status: "blocked" } : k));
  const v = ghView({ terminals });
  assert.deepEqual(v.waiting, [
    { key: "card:0", name: "gh-238r", question: "在等你确认", doing: "issue 238", state: "waiting", label: "等你", duration: null,
      focus: "t4c", url: "https://github.com/o/r/issues/238" },
    { key: "card:1", name: "gh-239", question: "在等你确认", doing: "issue 239", state: "waiting", label: "等你", duration: null,
      focus: "t4d", url: "https://github.com/o/r/issues/239" }]);
  assert.ok(!v.tasks.flatMap((g) => g.items).some((i) => i.id === "#238"));
  assert.deepEqual(ghView({ terminals: ghTree.map((k) => (k.address === "t4c" ? { ...k, status: "error" } : k)) }).waiting, []);
  const pane = panel([agent("t23", "blocked", "rm -rf build?", "leader agent")], ghIssues, { terminals: ghTree, board: github(...ghIssues) });
  assert.deepEqual(pane.waiting.map((c) => [c.name, c.question, c.doing, c.focus]), [["leader agent", "在等你确认", "rm -rf build?", "t23"]]);
});

const pend = (id, at, x) => ({ id, title: `issue ${id}`, status: "open", parent: null, url: `https://gh/${id.slice(1)}`,
  active_at: at, pending: { brief: `待决：${id}\n定不定？`, at, progress: [] }, ...x });
const pendBoard = (tasks) => ({ tracker: "github",
  columns: [{ key: "open", tasks: tasks.filter((t) => t.status !== "done") }, { key: "done", tasks: tasks.filter((t) => t.status === "done") }] });

const fullCard = { decision: "定不定", kr: "无", context: "c", rec: "A", options: [{ key: "A", text: "a", note: "x" }, { key: "B", text: "b", note: "y" }] };
test("pending cards run oldest first, a tie by issue number as a number, each with its URL; a closed issue holds none", () => {
  const withCard = (t) => (t.pending ? { ...t, pending: { ...t.pending, card: fullCard } } : t);
  const v = decisionCardsView(pendBoard([
    pend("#7", 300),
    pend("#12", 100),
    pend("#10", 200),
    pend("#9", 200),
    { id: "#8", title: "无待决", status: "open", pending: null },
    pend("#5", 50, { status: "done" }),
  ].map(withCard))).cards;
  assert.deepEqual(v.map((p) => p.id), ["#12", "#9", "#10", "#7"]);
  assert.deepEqual([v[3].key, v[3].url], ["pending:#7", "https://gh/7"]);
});

test("a card's row title is its Decision on one line, whatever the issue is called; on the Vercel Board too, where a hold with no complete card stays out", () => {
  const board = { columns: [{ key: "open", tasks: [
    pend("#7", 300, { pending: { at: 300, progress: [], card: { ...fullCard, decision: "传不传\nsourcemap" } } }),
    pend("#8", 200, { pending: { brief: "只有一句", at: 200, progress: [], card: null } })] }] };
  const v = decisionCardsView(board);
  assert.deepEqual(v.cards.map((c) => [c.id, c.title, c.decision, c.kind]), [["#7", "传不传 sourcemap", "传不传\nsourcemap", "pick"]]);
  assert.deepEqual(v.incomplete.ids, ["#8"]);
  const asking = panelView({ board: { columns: [{ key: "open", tasks: [{ ...board.columns[0].tasks[1], waiting: "只有一句", terminal: null, active_at: 2 }] }] },
    agents: [], terminals: [], space: "s", now: 10, lang: "zh" });
  assert.deepEqual(asking.waiting, [], "a hold for a decision is not a 等你 question beside its card");
});

const items = (prefix, n) => Array.from({ length: n }, (_, i) => ({ key: "task:" + prefix + i, id: prefix + i, note: null, gone: false }));
const sections = (groups, extra = {}) => taskSections(groups, { folds: {}, project: "p", shownAll: {}, ...extra });

test("inside 任务 停滞 and 进行中 start open, 待办 and 已完成 start folded; a fold the person chose is kept per project and group; OKR folds start closed", () => {
  const groups = TASK_GROUPS.map((group) => ({ group, items: items(group, 1) }));
  assert.deepEqual(sections(groups).map((s) => [s.key, s.open]), [["group:stopped", true], ["group:working", true], ["group:todo", false], ["group:done", false]]);
  const folds = { [foldKey("p", "stopped")]: false, [foldKey("p", "done")]: true, [foldKey("other", "working")]: false };
  assert.deepEqual(sections(groups, { folds }).map((s) => s.open), [false, true, false, true]);
  assert.equal(isGroupOpen(folds, "q", "stopped"), true);
  assert.equal(isGroupOpen({}, "p", "okr-untested:O"), false);
  assert.equal(foldKey(null, "todo"), ":todo");
  assert.deepEqual([...GROUP_OPEN_BY_DEFAULT], ["stopped", "working"]);
});

test("every group shows its first 3 and a row for the rest; showing all, the row folds them back; 3 or fewer, no row", () => {
  const done = (n) => [{ group: "done", items: items("d", n) }];
  const [capped] = sections(done(23));
  assert.deepEqual([capped.count, capped.items.map((x) => x.id), capped.more], [23, ["d0", "d1", "d2"], { hidden: 20 }]);
  assert.equal(ROWS_SHOWN_PER_GROUP, 3);
  const [all] = sections(done(23), { shownAll: { [foldKey("p", "done")]: true } });
  assert.deepEqual([all.items.length, all.more], [23, { hidden: 0 }]);
  assert.equal(sections(done(3))[0].more, null);
  assert.deepEqual(sections([{ group: "stopped", items: items("s", 9) }])[0].more, { hidden: 6 });
  assert.deepEqual([WINDOW_WORDS.zh.more(18), WINDOW_WORDS.zh.less, WINDOW_WORDS.en.more(18)], ["再显示 18 条", "收起", "Show 18 more"]);
});

test("no task row carries a reason line, 停滞 included; the reason stays in the row's details", () => {
  const stopped = [{ key: "task:A", id: "A", gone: true, note: "handoff\n原件兜底" }, { key: "task:B", id: "B", gone: false, note: null },
    { key: "task:C", id: "C", gone: false, note: "等判官" }];
  const [s, w] = sections([{ group: "stopped", items: stopped }, { group: "working", items: [{ key: "task:D", id: "D", note: "第 2 步" }] }]);
  assert.deepEqual(s.items.map((x) => x.why), [undefined, undefined, undefined]);
  assert.equal(w.items[0].why, undefined);
});

test("the arrows walk 待决, the KRs, then each group's header and, while it is open, its rows and the 已完成 row", () => {
  const groups = [{ group: "stopped", items: items("s", 1) }, { group: "working", items: items("w", 2) }, { group: "done", items: items("d", 6) }];
  const open = sections(groups, { folds: { [foldKey("p", "done")]: true } });
  const done = ["group:done", "task:d0", "task:d1", "task:d2", moreKey("done")];
  assert.deepEqual(panelKeys(["card:0", "pending:#7"], ["kr:0-0"], open), ["card:0", "pending:#7", "kr:0-0",
    "group:stopped", "task:s0", "group:working", "task:w0", "task:w1", ...done]);
  assert.deepEqual(panelKeys([], [], sections(groups, { folds: { [foldKey("p", "stopped")]: false, [foldKey("p", "working")]: false } })),
    ["group:stopped", "group:working", "group:done"]);
  assert.deepEqual([groupOfKey("group:todo"), groupOfKey("task:x"), groupOfKey(null)], ["todo", null, null]);
});

const okrFixture = JSON.parse(readFileSync(new URL("./okr.fixture.json", import.meta.url), "utf8"));

test("OKR objectives: the ones with a missed KR first, then the ones still unsure, all-met last; under each only the KRs not met, worst first", () => {
  const v = okrView(okrFixture, "zh");
  assert.equal(OKR_WORDS.zh.tally(v.met, v.total, v.measured), "3/7 达标 · 11-19 09:00 量");
  assert.deepEqual(v.objectives.map((o) => [o.name, o.standing, o.met, o.total]),
    [["听得懂需求", "missed", 2, 5], ["用户愿意拉人", "unsure", 0, 1], ["推荐能减少筛选", "met", 1, 1]]);
  const [first, unsure, allMet] = v.objectives;
  assert.deepEqual(first.krs.map((k) => k.status), ["missed", "stale"]);
  assert.deepEqual(first.untestedKrs.map((k) => k.name), ["误拦率"]);
  assert.deepEqual(first.metKrs.map((k) => k.name), ["长对话接着轮保留修饰", "意图准确率"]);
  assert.deepEqual([unsure.krs.length, unsure.untestedKrs.length, allMet.krs.length, allMet.metKrs.length], [0, 1, 0, 1]);
  assert.deepEqual(v.objectives.map((o) => o.fold), ["okr:听得懂需求", "okr:用户愿意拉人", "okr:推荐能减少筛选"]);
  assert.deepEqual(v.objectives.map((o) => o.untestedFold), ["okr-untested:听得懂需求", "okr-untested:用户愿意拉人", "okr-untested:推荐能减少筛选"]);
  assert.deepEqual([OKR_WORDS.zh.untestedFolded(3), OKR_WORDS.en.untestedFolded(3)], ["3 条未测", "3 untested"]);
});

test("OKR KR rows: actual against target, the variance the right way round, and the day it was read", () => {
  const v = okrView(okrFixture, "zh");
  assert.deepEqual([...v.objectives[0].krs, ...v.objectives[0].untestedKrs, ...v.objectives[0].metKrs].map((k) => [k.status, k.value, k.target, k.gap, k.day]), [
    ["missed", "84.6%", "≤ 20%", "-64.6 点", "11-19"], ["stale", "640ms", "< 800ms", "+160.0 ms", "10-01"],
    ["untested", "未测", "≤ 2%", null, null], ["met", "90.1%", "≥ 90%", "+0.1 点", "11-19"], ["met", "97.5%", "≥ 95%", "+2.5 点", "11-18"]]);
  assert.deepEqual([...v.objectives[0].krs, ...v.objectives[0].untestedKrs].map((k) => k.trend), ["在变差", "没动", "首次读数"]);
  const odd = okrView({ ...okrFixture, objectives: [{ name: "O", krs: [{ name: "k", target: ">= 1", status: "bogus", value: 3 }] }] }, "en");
  const [bogus] = odd.objectives[0].untestedKrs;
  assert.deepEqual([bogus.status, bogus.target, bogus.gap], ["untested", ">= 1", null]);
});

test("variance is actual minus target in the target's direction: + is ahead, - is behind, either side of = is behind; percent and 百分点 are counted in 点 (pt in English)", () => {
  const said = (op, goal, value, unit, w = OKR_WORDS.zh) => varianceText(gapOf(op, goal, value), unit, w);
  assert.deepEqual([said(">=", 95, 97.5, "%"), said("<=", 20, 83.3, "%"), said("<=", 5, 0, "%"), said(">=", 15, 12, "个百分点"),
    said("==", 7, 5, "张"), said("==", 7, 9, "张"), said("==", 0, 0, "次"), said(">=", 90, 90, "%"), said(">", 1, 3, ""), said("<", 800, 640, "ms")],
  ["+2.5 点", "-63.3 点", "+5.0 点", "-3.0 点", "-2.0 张", "-2.0 张", "+0.0 次", "+0.0 点", "+2.0", "+160.0 ms"]);
  assert.equal(said("<=", 20, 83.3, "%", OKR_WORDS.en), "-63.3 pt");
});

test("the OKR section is left out with no okr.toml, an older CLI, or a reply that is not the contract", () => {
  for (const x of [null, undefined, { error: "没有 docs/agents/okr.toml" }, { projects: [] }, { ...okrFixture, objectives: [] }]) {
    assert.equal(okrView(x, "zh"), null);
  }
});

test("OKR declarations: a KR off its word says so; an older CLI's json says nothing", () => {
  const okr = { ...okrFixture, objectives: [
    { name: "O", impacts: { "↑": 2, "↓": 1, "=": 0 }, krs: [
      { name: "a", target: ">= 1", status: "missed", value: 0, mismatch: [{ ticket: "#5", dir: "↑" }, { ticket: "KRI-07", dir: "=" }] },
      { name: "b", target: ">= 1", status: "met", value: 2, mismatch: [] }] },
    { name: "P", impacts: { "↑": 0, "↓": 0, "=": 0 }, krs: [{ name: "c", target: ">= 1", status: "untested" }] }] };
  const v = okrView(okr, "zh");
  assert.deepEqual([...v.objectives[0].krs, ...v.objectives[0].metKrs].map((k) => k.mismatch), ["预期不符 #5 KRI-07", null]);
  assert.equal(okrView(okr, "en").objectives[0].krs[0].mismatch, "Not as declared #5 KRI-07");
  const old = okrView(okrFixture, "zh");
  assert.ok(old.objectives.every((o) => [...o.krs, ...o.untestedKrs, ...o.metKrs].every((k) => k.mismatch === null)));
});

const cardOf = (options) => ({ decision: "定不定", kr: "长对话接着轮保留全部修饰", context: "本机不跑推理", rec: "B：两台都是自己的测评机",
  options: options ?? [{ key: "A", text: "一次性批准", note: "只管这一次" }, { key: "B", text: "加进白名单", note: "" }] });
const asked = (n, at, pending) => ({ id: "#" + n, title: "issue " + n, status: "open", url: "https://gh/" + n,
  pending: { brief: "待决：…", at, progress: [{ body: "早先", at: at - 60 }, { body: "长对话配对出分\n+7.6 点", at: at + 60 }], card: null, talk: null, ruled_after: false, ...pending } });
const decisionBoard = { tracker: "github", columns: [{ key: "open", tasks: [
  asked(1428, 300, { card: cardOf() }),
  asked(1536, 100, { card: cardOf(), ruled_after: true, talk: { window: null } }),
  asked(1472, 200, { card: cardOf(), talk: { window: "t1d2" } }),
  asked(1280, 400, {}), asked(1219, 500, {})] }] };
const roubaoTerminals = [
  { address: "t145", name: null, state: "live", cwd: "/r/roubao", labels: { role: "orchestrator" } },
  { address: "t16m", name: "vu1-orch", state: "live", cwd: "/r/vibeusage", labels: { role: "orchestrator" } },
  { address: "t1d2", name: null, state: "live", cwd: "/r/roubao", labels: {} }];

test("a pending card is incomplete without its fields, maybe decided once a later 进展 says the owner ruled, talk when it sends you to a window, else a pick", () => {
  const v = decisionCardsView(decisionBoard, { terminals: roubaoTerminals, repo: "/r/roubao" });
  assert.equal(v.orchestrator, "t145");
  assert.deepEqual(v.cards.map((c) => [c.id, c.kind]), [["#1536", "maybe"], ["#1472", "talk"], ["#1428", "pick"]]);
  const pick = v.cards[2];
  assert.equal(pick.sub, "#1428 · 长对话接着轮保留全部修饰 · " + decisionDate(300));
  assert.ok(pick.progress.endsWith("长对话配对出分 +7.6 点"));
  assert.deepEqual([pick.context, pick.rec, pick.options.map((o) => o.key), pick.window], ["本机不跑推理", "B：两台都是自己的测评机", ["A", "B"], null]);
  assert.deepEqual(v.cards[1].window, { focus: "t1d2", name: "t1d2" });
  assert.deepEqual(v.cards[0].window, null);
  assert.deepEqual(v.incomplete.ids, ["#1280", "#1219"]);
});

test("the talk button goes to the named window, or to the orchestrator once that window is gone; the orchestrator is this repo's live one", () => {
  const gone = roubaoTerminals.filter((k) => k.address !== "t1d2");
  assert.deepEqual(decisionCardsView(decisionBoard, { terminals: gone, repo: "/r/roubao" }).cards[1].window, { focus: "t145", name: "t145" });
  const elsewhere = decisionCardsView(decisionBoard, { terminals: gone, repo: "/r/other" });
  assert.deepEqual([elsewhere.orchestrator, elsewhere.cards[1].window], [null, { focus: null, name: "t1d2" }]);
  const dead = roubaoTerminals.map((k) => ({ ...k, state: "dead" }));
  assert.equal(decisionCardsView(decisionBoard, { terminals: dead, repo: "/r/roubao" }).orchestrator, null);
  assert.equal(decisionCardsView(decisionBoard, { terminals: roubaoTerminals, repo: "/r/vibeusage" }).orchestrator, "t16m");
  assert.deepEqual([repoRootOf("/r/roubao/.git\n"), repoRootOf(""), repoRootOf("/r/x.git")], ["/r/roubao", null, null]);
});

test("an incomplete card is returned once: what was sent stays remembered while the card is pending, and a rewritten card counts as new", () => {
  const first = decisionCardsView(decisionBoard, { terminals: roubaoTerminals, repo: "/r/roubao" });
  assert.deepEqual(first.incomplete.unreturned.map((x) => x.id), ["#1280", "#1219"]);
  const sent = first.incomplete.unreturned.map((x) => x.mark);
  const kept = marksStillToKeep(["#999@1"], first.incomplete, sent);
  assert.deepEqual(kept, ["#1280@400", "#1219@500"]);
  assert.deepEqual(decisionCardsView(decisionBoard, { terminals: roubaoTerminals, repo: "/r/roubao", returned: kept }).incomplete.unreturned, []);
  const rewritten = { ...decisionBoard, columns: [{ key: "open", tasks: [asked(1280, 900, {})] }] };
  assert.deepEqual(decisionCardsView(rewritten, { returned: kept }).incomplete.unreturned.map((x) => x.mark), ["#1280@900"]);
  assert.equal(TO_ORCHESTRATOR.incomplete(["#1280", "#1219"]), "[决策者经面板] 待决未就绪（不满足就绪标准），请按待决策项格式重写：#1280 #1219");
  assert.deepEqual([TO_ORCHESTRATOR.pick("#1428", "B"), TO_ORCHESTRATOR.unclear("#1428"), TO_ORCHESTRATOR.decided("#1536")],
    ["[决策者经面板] #1428 选 B", "[决策者经面板] #1428 背景不够，请补写后重发待决", "[决策者经面板] #1536 已定，请核实后记已决（决策记录）"]);
});

test("the panel opens on the tab the owner last picked; the first time on 待决 when something waits, else OKR", () => {
  assert.deepEqual(TABS, ["decide", "okr", "tasks"]);
  assert.deepEqual([openingTab("tasks", 3), openingTab("okr", 3), openingTab(undefined, 2), openingTab(undefined, 0), openingTab("bogus", 0)],
    ["tasks", "okr", "decide", "okr", "okr"]);
});

test("each tab's badge says whether it needs the owner: pending in amber, missed KRs in red or ✓ when all met, a plain count of open tasks", () => {
  const v = okrView(okrFixture, "zh");
  assert.deepEqual(tabBadges({ pending: 5, okr: v, openTasks: 7 }),
    { decide: { text: "5", tone: "ask" }, okr: { text: "1", tone: "missed" }, tasks: { text: "7", tone: "plain" } });
  const met = okrView({ ...okrFixture, objectives: [{ name: "O", krs: [{ name: "k", target: ">= 1", target_op: ">=", target_value: 1, status: "met", value: 2 }] }] }, "zh");
  const unsure = okrView({ ...okrFixture, objectives: [{ name: "O", krs: [{ name: "k", target: ">= 1", status: "untested" }] }] }, "zh");
  assert.deepEqual(tabBadges({ pending: 0, okr: met, openTasks: 0 }), { decide: null, okr: { text: "✓", tone: "met" }, tasks: null });
  assert.deepEqual([tabBadges({ pending: 0, okr: unsure, openTasks: 0 }).okr, tabBadges({ pending: 0, okr: null, openTasks: 0 }).okr], [null, null]);
});

test("a card's subtitle leaves out a KR that is empty or 无", () => {
  const withKr = (kr) => ({ tracker: "github", columns: [{ key: "open", tasks: [asked(1280, 300, { card: { ...cardOf(), kr } })] }] });
  assert.deepEqual(["无", " 无 ", "", null].map((kr) => decisionCardsView(withKr(kr)).cards[0].sub), Array(4).fill("#1280 · " + decisionDate(300)));
  assert.equal(decisionCardsView(withKr("留存")).cards[0].sub, "#1280 · 留存 · " + decisionDate(300));
});
