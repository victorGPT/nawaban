import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFor, resolveLang, moveSelection, keyCommand, boardChanged, windowsView, leadersView, itemLabel, decisionDate, WINDOW_WORDS } from "./logic.js";

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

test("the arrow keys move the selection through cards and rows together, and stop at either end", () => {
  const keys = ["card", "row1", "row2"];
  assert.equal(moveSelection(keys, null, 1), "card"); // nothing picked yet: down starts at the top
  assert.equal(moveSelection(keys, null, -1), "row2"); // and up at the bottom
  assert.equal(moveSelection(keys, "card", 1), "row1");
  assert.equal(moveSelection(keys, "row1", -1), "card");
  assert.equal(moveSelection(keys, "row2", 1), "row2");
  assert.equal(moveSelection(keys, "card", -1), "card");
  assert.equal(moveSelection(keys, "GONE", 1), "card"); // a window that left the panel
  assert.equal(moveSelection([], null, 1), null);
});

test("keys become the panel's commands: arrows move, Enter goes to the window, Esc goes back", () => {
  const press = (keystroke, key_char) => keyCommand({ keystroke, key: keystroke, key_char });
  assert.equal(press("down"), "down");
  assert.equal(press("up"), "up");
  assert.equal(press("enter"), "open");
  assert.equal(press("escape"), "back");
  assert.equal(press("/", "/"), null); // no filter box any more
  assert.equal(press("cmd-down"), null); // chords stay Herdr's
  assert.equal(press("a", "a"), null);
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

// Herdr agents (AgentInfo) and `nawaban json board` tasks, as windowsView reads them.
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

test("an idle window holding an open task is 停了 on that task, for as long as since its latest event", () => {
  const tasks = [held("A", "t1", { title: "解析 Frontmatter", active_at: NOW - 3 * 3600 }), held("B", "elsewhere")];
  const v = view([agent("t1", "idle", "zsh", "解析")], tasks);
  assert.deepEqual(v.rows, [{ name: "解析", doing: "解析 Frontmatter", state: "stopped", label: "停了", duration: "3h", focus: "t1" }]);
  assert.equal(view([agent("t1", "idle", "zsh", "解析")], tasks, { lang: "en" }).rows[0].label, "Stopped");
});

test("a window that finished unseen is 完成; one idle with no open task is 空闲, collapsed into the idle row", () => {
  const tasks = [held("OLD", "t2", { status: "done" })];
  const v = view([agent("t1", "done", "知识库重试", "13"), agent("t2", "idle", "zsh", "7"), agent("t3", "idle", "~", "")], tasks);
  // a tab nobody named is called by its index ("13"): never a name, the terminal title instead
  assert.deepEqual(v.rows.map((r) => [r.name, r.doing, r.state, r.label]), [["知识库重试", "知识库重试", "done", "完成"]]);
  assert.deepEqual(v.idle, { count: 2, names: ["zsh", "~"] });
});

test("a window is named by its Herdr terminal name first, then its tab's name, then its terminal title", () => {
  const agents = [agent("t1", "working", "读字段", "分析 CRM"), agent("t2", "working", "读字段", "4"), agent("t3", "working", "读字段", "")];
  const terminals = [{ address: "t1", name: "gh-239", state: "live" }, { address: "t2", name: "gh-256", state: "live" }];
  assert.deepEqual(view(agents, [], { terminals }).rows.map((r) => r.name), ["gh-239", "gh-256", "读字段"]);
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
  // the windows listed are this space's only
  assert.deepEqual(v.rows.map((r) => r.focus), []);
  assert.deepEqual(v.idle, { count: 0, names: [] });
});

test("the header counts what waits on you in the other projects of `json projects`", () => {
  const projects = { projects: [{ name: "nawaban", waiting: 4 }, { name: "roubao", waiting: 2 }, { name: "huafa", waiting: 1 }] };
  assert.equal(view([], [], { projects, project: "nawaban" }).otherWaiting, 3);
  assert.equal(view([]).otherWaiting, 0);
});

// `nawaban json board` tasks as leadersView reads them: open ones carry progress, blocked_by (open
// blockers only), waiting and decision; done ones carry done_at and none of those.
const task = (id, { status = "open", session = null, leader = session, terminal = null, parent = null, created_at = 0,
  claimed_at = null, active_at = 0, done_at = null, progress = null, blocked_by = [], decision = null, title = id } = {}) =>
  status === "done"
    ? { id, title, status, parent, session, created_at, active_at, terminal, leader, claimed_at, done_at }
    : { id, title, status, parent, session, created_at, active_at, terminal, leader, claimed_at,
      progress: progress && { body: progress, at: active_at }, blocked_by, waiting: null, decision };
const leaders = (agents, tasks, extra = {}) =>
  leadersView({ agents, space: "here", board: boardOf(...tasks), now: NOW, lang: "zh", ...extra });

test("a leader's items are numbered by first claim, not by id; unclaimed ones after, by creation", () => {
  const v = leaders([agent("t1", "working", "claude", "入职")], [
    task("A-9", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 100 }),
    task("A-1", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 500 }), // added later
    task("A-5", { leader: "L", created_at: 50 }), // dispatched, no worker on it yet
    task("A-2", { leader: "L", created_at: 40 })]);
  assert.deepEqual(v.groups.map((g) => [g.name, g.items.map((i) => [i.number, i.id])]),
    [["入职", [[1, "A-9"], [2, "A-1"], [3, "A-2"], [4, "A-5"]]]]);
});

test("a dispatched task sits in its leader's group, done by a worker, with the worker's latest note", () => {
  const L = "d9194652-1420-4755", W = "eb2f6c83-4582-41e5";
  const v = leaders([agent("t1", "working", "claude", "入职"), agent("t2", "working", "claude", "w")], [
    task("OWN", { status: "in_progress", session: L, terminal: "t1", claimed_at: 1, progress: "verify：3814 个测试通过" }),
    // agent-center writes its dispatch notes as `ac:<session>`: the same leader
    task("SENT", { status: "in_progress", session: W, leader: `ac:${L}`, terminal: "t2", claimed_at: 2, progress: "handoff：原件兜底" }),
    task("QUEUED", { leader: `ac:${L}`, created_at: 3 }), // dispatched, not started
    task("PUT-BACK", { leader: W, claimed_at: 4 })]); // released: nobody is on it, so it is in no group
  assert.equal(v.groups.length, 1);
  const g = v.groups[0];
  assert.deepEqual([g.name, g.self, g.dispatched], ["入职", 1, 2]);
  assert.deepEqual(g.items.map((i) => [i.id, i.state, i.who, i.note, i.focus]), [
    ["OWN", "current", "self", "verify：3814 个测试通过", "t1"],
    ["SENT", "current", "worker", "handoff：原件兜底", "t2"],
    ["QUEUED", "todo", "worker", null, null]]);
});

test("a spec is one item in its tickets' place, its segments in blocked-by order: done ones first, then the open ones", () => {
  const v = leaders([agent("t2", "working", "claude", "w"), agent("t9", "working", "claude", "报表")], [
    task("S-03", { parent: "S", leader: "L", blocked_by: ["S-02"], created_at: 3 }), // dispatched, waits on S-02
    task("S-04", { parent: "S", leader: "L", created_at: 4 }), // its blocker S-01 is done, so none listed
    task("S-02", { parent: "S", status: "in_progress", session: "W", leader: "L", terminal: "t2", claimed_at: 20, progress: "第 3 张" }),
    task("S-01", { parent: "S", status: "done", leader: "L", claimed_at: 10, done_at: NOW - 3600 }),
    task("S", { title: "报表迁到新底座" }), // a spec nobody claims
    task("T", { status: "in_progress", session: "L", terminal: "t9", claimed_at: 15 })]);
  const g = v.groups[0];
  assert.deepEqual(v.groups.map((x) => x.leader), ["L"]);
  assert.deepEqual(g.items.map((i) => [i.number, i.id]), [[1, "S"], [2, "T"]]); // the spec arrived with its first claim
  const spec = g.items[0];
  assert.deepEqual([spec.title, spec.state, spec.who, spec.note, spec.focus], ["报表迁到新底座", "current", "worker", "第 3 张", "t2"]);
  assert.deepEqual(spec.spec, { tickets: ["S-01", "S-04", "S-02", "S-03"], segments: ["done", "todo", "current", "todo"], done: 1, total: 4 });
  assert.deepEqual([g.self, g.dispatched], [1, 1]);
});

test("a held item whose terminal is idle or gone is stopped; gone, it has no window to go to", () => {
  const v = leaders([agent("t1", "idle", "zsh", "入职"), agent("o1", "working", "claude", "别处", 0, "other")], [
    task("IDLE", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 1, active_at: NOW - 7200 }),
    task("GONE", { status: "in_progress", session: "W", leader: "L", terminal: "closed", claimed_at: 2, progress: "handoff" }),
    task("AWAY", { status: "in_progress", session: "W2", leader: "L", terminal: "o1", claimed_at: 3 }), // another space: not gone
    task("NO-TERMINAL", { status: "in_progress", session: "W3", leader: "L", claimed_at: 4 })]); // unknown: taken as working
  assert.deepEqual(v.groups[0].items.map((i) => [i.id, i.state, i.gone, i.focus, i.note]), [
    ["IDLE", "stopped", false, "t1", null],
    ["GONE", "stopped", true, null, "handoff"],
    ["AWAY", "current", false, "o1", null],
    ["NO-TERMINAL", "current", false, null, null]]);
  assert.equal(v.groups[0].items[0].at, NOW - 7200); // stopped since its latest event
  assert.equal(v.groups[0].items[2].at, 3); // current since its first claim
});

test("a done item stays for 24 hours after it was done, then leaves; a leader with nothing else leaves with it", () => {
  const v = leaders([], [
    task("FRESH", { status: "done", leader: "L", claimed_at: 1, done_at: NOW - 23 * 3600 }),
    task("OLD", { status: "done", leader: "L", claimed_at: 2, done_at: NOW - 25 * 3600 }),
    task("GONE-BY", { status: "done", leader: "M", claimed_at: 3, done_at: NOW - 25 * 3600 })]);
  assert.deepEqual(v.groups.map((g) => [g.leader, g.items.map((i) => [i.id, i.state, i.at, i.who])]),
    [["L", [["FRESH", "done", NOW - 23 * 3600, null]]]]);
});

test("a leader's decision is the newest recorded on any of its open items, a spec's tickets included", () => {
  const decided = (at, verdict) => ({ at, verdict });
  const v = leaders([], [
    task("A", { status: "in_progress", session: "L", claimed_at: 1, decision: decided(500, "旧报表先只读并存两周") }),
    task("S-1", { parent: "S", status: "in_progress", session: "W", leader: "L", claimed_at: 2, decision: decided(900, "原件兜底存一份\n第二行不显示") }),
    task("S", { decision: decided(700, "spec 的决定") }),
    task("B", { status: "in_progress", session: "M", claimed_at: 3 })]);
  assert.deepEqual(v.groups.map((g) => [g.leader, g.decision]), [["L", { at: 900, verdict: "原件兜底存一份" }], ["M", null]]);
});

test("groups with a stopped item come first, then the one that moved most recently", () => {
  const v = leaders([agent("t1", "idle", "zsh")], [
    task("OLDEST", { status: "in_progress", session: "A", claimed_at: 1, active_at: 100 }),
    task("STUCK", { status: "in_progress", session: "B", terminal: "t1", claimed_at: 1, active_at: 50 }),
    task("LATEST", { status: "in_progress", session: "C", claimed_at: 1, active_at: 300 }),
    task("C-DONE", { status: "done", leader: "A", claimed_at: 2, active_at: 400, done_at: NOW - 60 })]);
  assert.deepEqual(v.groups.map((g) => g.leader), ["B", "A", "C"]);
});

test("the arrows walk the cards, then the items with a window, each once, though they share a terminal", () => {
  const asking = { ...task("Q", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 1 }), waiting: "放行吗？" };
  const v = leaders([agent("t1", "working", "claude", "入职")], [asking,
    task("R", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 2 }),
    task("NOWHERE", { status: "in_progress", session: "L", claimed_at: 3 })]); // no terminal: nothing to go to
  assert.deepEqual(v.keys, ["card:0", "L/Q", "L/R"]);
  assert.deepEqual([v.waiting[0].key, ...v.groups[0].items.map((i) => i.key)], ["card:0", "L/Q", "L/R", "L/NOWHERE"]);
  assert.equal(moveSelection(v.keys, "L/Q", 1), "L/R");
});

test("an item's state says since when: done at a time of day, today or yesterday; current and stopped for how long", () => {
  const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime() / 1000; // local time, as the panel shows it
  const now = at(6, 12, 0);
  const label = (state, when, lang = "zh") => itemLabel({ state, at: when }, now, lang);
  assert.equal(label("done", at(6, 9, 10)), "完成 09:10");
  assert.equal(label("done", at(5, 18, 40)), "完成 昨天 18:40");
  assert.equal(label("done", at(4, 18, 40)), "完成 11-04 18:40");
  assert.equal(label("done", at(5, 18, 40), "en"), "Done yesterday 18:40");
  assert.equal(label("current", now - 40 * 60), "在干 40 分钟");
  assert.equal(label("current", now - 30), "在干 刚刚");
  assert.equal(label("stopped", now - 2 * 3600 - 59), "停了 2 小时");
  assert.equal(label("stopped", now - 2 * 3600, "en"), "Stopped 2h");
  assert.equal(label("current", null), "在干"); // claimed with no claim event
  assert.equal(label("todo", null), "还没动");
  assert.equal(decisionDate(at(5, 23, 59)), "11-05");
});

test("every window of the space holding no task is in the last row, whatever Herdr says it is doing", () => {
  const v = leaders([agent("t1", "working", "claude", "部署"), agent("t2", "idle", "zsh", "闲聊"),
    agent("t3", "working", "claude", "入职"), agent("t4", "blocked", "rm?", "确认"), agent("t5", "done", "claude", "13"),
    agent("o1", "working", "claude", "别处", 0, "other")],
  [task("A", { status: "in_progress", session: "L", terminal: "t3", claimed_at: 1 })]);
  // t3 is its task's item, t4 a card, o1 another space's
  assert.deepEqual(v.idle, { count: 3, names: ["部署（在干）", "闲聊", "claude（完成）"] }); // tab "13": unnamed
  assert.equal(WINDOW_WORDS.zh.idleRow(v.idle.count, v.idle.names), "没认领 3 · 部署（在干）、闲聊、claude（完成）");
  const en = leaders([agent("t1", "working", "claude", "deploy"), agent("t2", "idle", "zsh", "chat")], [], { lang: "en" });
  assert.equal(WINDOW_WORDS.en.idleRow(en.idle.count, en.idle.names), "No task 2 · deploy (working), chat");
});

test("a held task the board gives no leader is led by its holder: it never vanishes from the panel", () => {
  for (const leader of [null, undefined]) {
    const held = { ...task("A", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 1 }), leader };
    const v = leaders([agent("t1", "working", "claude", "入职")], [held]);
    assert.deepEqual(v.groups.map((g) => [g.leader, g.name, g.items.map((i) => [i.id, i.state, i.who, i.focus])]),
      [["L", "入职", [["A", "current", "self", "t1"]]]], `leader ${leader}`);
    assert.deepEqual([v.idle.count, v.keys], [0, ["L/A"]]);
  }
});

test("a spec held itself, none of its tickets held, speaks for itself: current or stopped, its note, its window", () => {
  const spec = (status) => [task("S", { status: "in_progress", session: "L", terminal: "t1", claimed_at: 1, active_at: 5, progress: "拆票中" }),
    task("S-01", { parent: "S", leader: "L", created_at: 2 })]; // dispatched, not started
  for (const [herdr, state] of [["working", "current"], ["idle", "stopped"]]) {
    const v = leaders([agent("t1", herdr, "claude", "入职")], spec());
    assert.deepEqual(v.groups[0].items.map((i) => [i.id, i.state, i.who, i.note, i.focus]),
      [["S", state, "self", "拆票中", "t1"]], herdr);
    assert.deepEqual([v.idle.count, v.keys], [0, ["L/S"]]);
  }
});

// Herdr's terminal tree (`terminals()`): a leader started its workers with `hc run`, so they are its
// children and have no pane, hence no AgentInfo. As in the roubao space on 2026-11-06.
const kid = (address, name, status, parent = "t23") => ({ address, name, parent, status, state: "live" });
const roubao = [{ address: "t23", name: null, parent: null, status: "idle", state: "live" },
  kid("t4r", "gh-256", "working"), kid("t4n", "gh-239", "done"), kid("t4p", "gh-238r", "idle")];

test("a leader terminal's children are its items, by Herdr name, in start order, none in the last row", () => {
  const terminals = [...roubao, { ...kid("t4s", "ended", "done"), state: "finished" }, kid("t4u", "gh-260", "blocked")];
  const v = leaders([agent("t23", "idle", "claude", "leader agent"), agent("t1z", "idle", "claude", "4")], [], { terminals });
  // holding no task, a child Herdr says is idle has finished: Herdr turns done into idle once you look
  assert.deepEqual(v.groups.map((g) => [g.leader, g.name, g.self, g.dispatched,
    g.items.map((i) => [i.number, i.title, i.state, i.who, i.focus])]), [["t23", "leader agent", 0, 4, [
    [1, "gh-239", "done", "worker", "t4n"], [2, "gh-238r", "done", "worker", "t4p"], [3, "gh-256", "current", "worker", "t4r"],
    [4, "gh-260", "waiting", "worker", "t4u"]]]]); // blocked: it waits on you
  assert.equal(itemLabel(v.groups[0].items[3], NOW, "zh"), "等你");
  assert.deepEqual(v.idle, { count: 1, names: ["claude"] }); // t1z: neither the leader nor its children
  assert.deepEqual(v.keys, ["t23/t4n", "t23/t4p", "t23/t4r", "t23/t4u"]);
  // a terminal with no children and no task stays in the last row, under its Herdr name when it has one
  const named = leaders([agent("t1z", "idle", "claude", "4")], [], { terminals: [{ address: "t1z", name: "kb", parent: null, state: "live" }] });
  assert.deepEqual([named.groups, named.idle], [[], { count: 1, names: ["kb"] }]);
});

test("a child holding a nawaban task shows the task and its note; the leader's own tasks and the ones it dispatched with no window yet join its group", () => {
  const v = leaders([agent("t23", "working", "claude", "leader agent")], [
    task("OWN", { status: "in_progress", session: "L", terminal: "t23", claimed_at: 5, progress: "拆票" }),
    task("GH", { status: "in_progress", session: "W", leader: "L", terminal: "t4n", claimed_at: 9, progress: "第 2 步" }),
    task("QUEUED", { leader: "L", created_at: 3 }), // dispatched, not started: only the board knows its leader
    task("IDLE", { status: "in_progress", session: "W2", leader: "L", terminal: "t4p", claimed_at: 7, active_at: 50 }),
    task("ELSE", { status: "in_progress", session: "M", claimed_at: 1 })], { terminals: roubao });
  assert.deepEqual(v.groups.map((g) => [g.leader, g.name, g.self, g.dispatched]), [["t23", "leader agent", 1, 4], ["M", "M", 1, 0]]);
  assert.deepEqual(v.groups[0].items.map((i) => [i.number, i.title, i.name, i.state, i.who, i.note, i.focus]), [
    [1, "GH", "gh-239", "current", "worker", "第 2 步", "t4n"], // t4n is Herdr-done: the task is still held
    [2, "IDLE", "gh-238r", "stopped", "worker", null, "t4p"], // idle, holding an open task: stopped
    [3, "gh-256", undefined, "current", "worker", null, "t4r"],
    [4, "OWN", undefined, "current", "self", "拆票", "t23"],
    [5, "QUEUED", undefined, "todo", "worker", null, null]]);
});
