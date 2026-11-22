import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { panelView, okrView, OKR_WORDS, WINDOW_WORDS, BOARD_PROJECTS, MORE_DONE_KEY } from "./logic.js";

const called = new Set();
let lastId = null;
const ids = new Set();
const clicks = new Map();
const hovers = new Map();
const texts = [];
const el = new Proxy({}, {
  get: (_, name) => typeof name === "symbol" ? undefined : (...args) => {
    called.add(name);
    if (name === "when") return args[0] ? args[1](el) : el;
    if (name === "hover") args[0](el);
    if (name === "id") { lastId = args[0]; ids.add(args[0]); }
    if (name === "on_click") clicks.set(lastId, args[0]);
    if (name === "on_hover") hovers.set(lastId, args[0]);
    if (name === "child" && typeof args[0] === "string") texts.push(args[0]);
    return el;
  },
});
const make = (name) => (...args) => el[name](...args);

const now = Math.floor(Date.now() / 1000);
const agent = (address, status, tab_name) => ({ address, status, tab_name, title: "claude", space: "here", seq: 1 });
const open = (id, x) => ({ id, title: `${id} 的标题`, status: "open", parent: null, session: null, leader: null, terminal: null,
  claimed_at: null, created_at: 0, active_at: now - 600, progress: null, blocked_by: [], waiting: null, decision: null, ...x });
const note = (body) => ({ body, at: now - 600 });
const agents = [agent("t1", "working", "入职"), agent("t2", "working", "w"), agent("t3", "idle", "问"),
  agent("t4", "idle", "闲聊"), agent("t5", "working", "部署"), agent("t6", "idle", "leader agent")];
const kid = (address, name, status) => ({ address, name, parent: "t6", status, state: "live" });
let terminals = [...agents.map((a) => ({ address: a.address, name: null, parent: null, status: a.status, state: "live" })),
  kid("t7", "gh-239", "working"), kid("t8", "gh-256", "done"), kid("t9", "gh-260", "blocked")];
const board = { columns: [
  { key: "in_progress", tasks: [
    open("CUR", { status: "in_progress", session: "L", leader: "L", terminal: "t1", claimed_at: now - 2400,
      progress: note("verify：测试通过"), decision: { at: now - 900, verdict: "先只读\n第二行不显示" } }),
    open("GONE", { status: "in_progress", session: "W", leader: "L", terminal: "closed", claimed_at: now - 2000, progress: note("handoff") }),
    open("S-02", { status: "in_progress", parent: "S", session: "W2", leader: "L", terminal: "t2", claimed_at: now - 1800, progress: note("第 3 张") }),
    open("Q", { status: "in_progress", session: "M", leader: "M", terminal: "t3", claimed_at: now - 1200, waiting: "放行吗？" }),
    open("GH", { status: "in_progress", session: "K", leader: "K", terminal: "t7", claimed_at: now - 300, progress: note("第 2 步") })] },
  { key: "open", tasks: [open("TODO", { leader: "L", created_at: 4 }), open("S", { title: "报表迁到新底座" }),
    open("S-03", { parent: "S", leader: "L", blocked_by: ["S-02"] })] },
  { key: "done", tasks: [
    { id: "DONE", title: "已做完", status: "done", parent: null, session: null, leader: "L", terminal: null, claimed_at: now - 7200,
      created_at: 0, active_at: now - 3600, done_at: now - 3600 },
    { id: "S-01", title: "S-01", status: "done", parent: "S", session: null, leader: "L", terminal: null, claimed_at: now - 5000,
      created_at: 0, active_at: now - 3000, done_at: now - 3000 }] }] };

const issue = (n, x) => open(`#${n}`, { title: `issue ${n}`, ...x });
const ghBoard = { tracker: "github", columns: [
  { key: "in_progress", tasks: [issue(239, { status: "in_progress", session: "gh-239", claimed_at: now - 600, progress: note("第 2 步") })] },
  { key: "open", tasks: [issue(256, { active_at: now - 3600 })] },
  { key: "done", tasks: [{ id: "#260", title: "issue 260", status: "done", parent: null, session: null, leader: null, terminal: null,
    claimed_at: null, created_at: 0, active_at: now - 600, done_at: now - 600 }] }] };
let execImpl = async () => ({ code: 1 });
let runImpl = async () => {};
let hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
const here = { spaces: () => [{ id: "here", active: true, name: "nawaban", folder: "/x" }], focused: () => ({ space: "here", cwd: "/x" }) };
let where = here;

const stubs = {
  "gpui-kit": { View: class {}, div: make("div"), svg: make("svg") },
  "gpui-base": { v_flex: make("v_flex"), h_flex: make("h_flex"), Popover: el, HoverCard: el },
  herdr: { spaces: () => where.spaces(), focused: () => where.focused(),
    agents: () => agents, terminals: () => terminals, home: () => "/h",
    run: (...a) => runImpl(...a), exec: (...a) => execImpl(...a), hc: (...a) => hcImpl(...a), checking: () => false, nextCommand: () => new Promise(() => {}), watchFolder: () => new Promise(() => {}), props: () => null, closeOverlay: () => null },
};
globalThis.__nawabanStubs = stubs;
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true,
  value: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), clear: () => stored.clear() } });
registerHooks({
  resolve: (specifier, context, next) => specifier in stubs ? { url: `stub:${specifier}`, shortCircuit: true } : next(specifier, context),
  load: (url, context, next) => !url.startsWith("stub:") ? next(url, context) : { format: "module", shortCircuit: true,
    source: Object.keys(stubs[url.slice(5)]).map((k) => `export const ${k} = globalThis.__nawabanStubs[${JSON.stringify(url.slice(5))}].${k};`).join("\n") },
});
const { default: NawabanBoard } = await import("./main.js");

const dts = [`${homedir()}/.config/herdr-app/gpui-kit.d.ts`, new URL("./gpui-kit.d.ts", import.meta.url)]
  .map((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }).find(Boolean);

const cxOf = (focused = false) => ({ spawn() {}, notify() {}, stop_propagation() {}, timer: { every() {} },
  focus_handle: () => ({ is_focused: () => focused, focus() {} }) });
const drawn = (x = {}, cx = cxOf()) => {
  const view = new NawabanBoard();
  view.init({}, cx);
  Object.assign(view, { lang: "zh", board, ...x });
  texts.length = 0;
  view.render(cx);
  return view;
};
const after = (...said) => {
  const at = said.reduce((found, s) => [...found, texts.indexOf(s, (found.at(-1) ?? -1) + 1)], []);
  return at.every((i) => i >= 0) || at.join(",");
};

test("the panel draws 待你决定, then the OKR reading, then 停了 在做 没动 完成, in Chinese and English, with Herdr's API only", () => {
  const v = panelView({ agents, terminals, space: "here", board, now, lang: "zh" });
  assert.deepEqual(v.waiting.map((c) => c.focus), ["t3"]);
  assert.deepEqual(v.tasks.map((g) => [g.group, g.items.map((i) => i.id)]),
    [["stopped", ["GONE"]], ["working", ["CUR", "GH", "S"]], ["todo", ["TODO"]], ["done", ["DONE"]]]);
  stored.clear();
  for (const lang of ["zh", "en"]) {
    drawn({ lang, okr: okrFixture });
    const w = WINDOW_WORDS[lang], o = OKR_WORDS[lang];
    assert.equal(after(w.decide, "放行吗？", o.title, "听得懂需求", w.groups.stopped, w.groups.working, w.groups.todo, w.groups.done), true, lang);
    assert.ok(!texts.includes(w.go), "去窗口 waits for a hover or a selection");
  }
  const opened = drawn();
  clicks.get("nawaban-group:working")({}, cxOf());
  opened.render(cxOf());
  stored.clear();
  assert.ok(called.has("loop") && called.has("on_hover") && called.has("trigger"), "the dots breathe and the rows carry hover cards");
});

test("停了 starts open and the rest folded; Enter or a click on a header folds and opens it, and a reopened panel keeps each choice per project", () => {
  stored.clear();
  const cx = cxOf(true);
  const view = drawn({}, cx);
  assert.deepEqual(view.keys, ["card:0", "group:stopped", "task:GONE", "group:working", "group:todo", "group:done"]);
  while (view.selectedKey !== "group:working") view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "enter" }, cx);
  view.render(cx);
  assert.deepEqual(view.keys.slice(3, 7), ["group:working", "task:CUR", "task:GH", "task:S"]);
  view.onKey({ keystroke: "up" }, cx);
  view.onKey({ keystroke: "up" }, cx);
  assert.equal(view.selectedKey, "group:stopped");
  view.onKey({ keystroke: "enter" }, cx);
  clicks.get("nawaban-group:todo")({}, cx);
  view.render(cx);
  assert.deepEqual(view.keys, ["card:0", "group:stopped", "group:working", "task:CUR", "task:GH", "task:S", "group:todo", "task:TODO", "group:done"]);
  const reopened = drawn({}, cx);
  assert.deepEqual(reopened.keys, view.keys);
  const elsewhere = drawn({ project: "other" }, cx);
  assert.deepEqual(elsewhere.keys, ["card:0", "group:stopped", "task:GONE", "group:working", "group:todo", "group:done"]);
  stored.clear();
});

test("完成 shows its newest 5, then 再显示 N 条; Enter on it shows all and 收起, remembered when the panel opens again", () => {
  stored.clear();
  const cx = cxOf(true);
  const done = (i) => ({ id: "D" + i, title: "done " + i, status: "done", parent: null, session: null, terminal: null, claimed_at: 1,
    created_at: 0, active_at: now - 60 * i, done_at: now - 60 * i });
  const many = { columns: [...board.columns.filter((c) => c.key !== "done"), { key: "done", tasks: Array.from({ length: 8 }, (_, i) => done(i)) }] };
  const view = drawn({ board: many }, cx);
  clicks.get("nawaban-group:done")({}, cx);
  view.render(cx);
  assert.deepEqual(view.keys.slice(-7), ["group:done", "task:D0", "task:D1", "task:D2", "task:D3", "task:D4", MORE_DONE_KEY]);
  texts.length = 0;
  view.render(cx);
  assert.ok(texts.includes("再显示 3 条"));
  while (view.selectedKey !== MORE_DONE_KEY) view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "enter" }, cx);
  texts.length = 0;
  view.render(cx);
  assert.ok(texts.includes("收起"));
  assert.equal(view.keys.filter((k) => k.startsWith("task:D")).length, 8);
  const reopened = drawn({ board: many }, cx);
  assert.equal(reopened.keys.filter((k) => k.startsWith("task:D")).length, 8);
  clicks.get("nawaban-more-done")({}, cx);
  reopened.render(cx);
  assert.equal(reopened.keys.filter((k) => k.startsWith("task:D")).length, 5);
  stored.clear();
});

test("only 待你决定 and 停了 rows get a second line, the reason; 在做 没动 完成 stay one line", () => {
  stored.clear();
  const view = drawn({}, cxOf());
  for (const k of ["group:working", "group:todo", "group:done"]) clicks.get("nawaban-" + k)({}, cxOf());
  view.render(cxOf());
  const why = (key) => view.selectableByKey.get(key).why;
  assert.deepEqual([why("card:0"), why("task:GONE")], ["放行吗？", "窗口已关，任务还拿着没交还 · handoff"]);
  assert.deepEqual(["task:CUR", "task:GH", "task:TODO", "task:DONE"].map(why), [null, null, null, null]);
  stored.clear();
});

test("去窗口 takes the place of the time while a row is hovered or selected, and goes there; a selected row opens its details below it with the keyboard", () => {
  stored.clear();
  const focused = [];
  runImpl = async (cmd, args) => { focused.push([cmd, args]); };
  try {
    const cx = cxOf(true);
    const view = drawn({}, cx);
    hovers.get("nawaban-row-task:GONE")(true, cx);
    assert.equal(view.hovered, "task:GONE");
    texts.length = 0;
    view.render(cx);
    assert.ok(!texts.includes(WINDOW_WORDS.zh.go), "GONE has no window to go to");
    hovers.get("nawaban-row-card:0")(true, cx);
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.go));
    hovers.get("nawaban-row-card:0")(false, cx);
    assert.equal(view.hovered, null);
    ids.clear();
    view.onKey({ keystroke: "down" }, cx);
    view.render(cx);
    assert.equal(view.selectedKey, "card:0");
    assert.ok(ids.has("nawaban-facts-card:0"));
    view.onKey({ keystroke: "enter" }, cx);
    assert.deepEqual(focused, [["agent.focus", { terminal: "t3" }]]);
    ids.clear();
    drawn({}, cxOf(false)).selectedKey = "card:0";
    assert.ok(!ids.has("nawaban-facts-card:0"), "without the keyboard the hover card carries the details");
  } finally {
    runImpl = async () => {};
    stored.clear();
  }
});

const cardOf = { decision: "放不放行", kr: "长对话接着轮保留全部修饰", context: "本机不跑推理", rec: "B：两台都是自己的测评机",
  options: [{ key: "A", text: "一次性批准", note: "只管这一次" }, { key: "B", text: "加进白名单", note: "" }] };
const pendingIssue = (n, at, x) => issue(n, { url: "https://gh/" + n,
  pending: { brief: "待决：…", at: now - at, progress: [{ body: "出分了", at: now - at + 60 }], card: cardOf, talk: null, ruled_after: false, ...x } });
const cardsBoard = { ...ghBoard, columns: ghBoard.columns.map((c) => c.key !== "open" ? c : { ...c, tasks: [
  pendingIssue(1428, 3000), pendingIssue(1536, 5000, { ruled_after: true }), pendingIssue(1472, 4000, { talk: { window: "t9" } }),
  pendingIssue(1280, 2000, { card: null })] }) };
const orchestrator = { address: "t0", name: null, parent: null, status: "done", state: "live", cwd: "/r/roubao", labels: { role: "orchestrator" } };
const runningSpawns = { spawn: (f) => f({ spawn() {}, notify() {} }), notify() {}, stop_propagation() {}, timer: { every() {} },
  focus_handle: () => ({ is_focused: () => false, focus() {} }) };
const settle = () => new Promise((r) => setImmediate(r));
const inChinese = () => { stored.clear(); stored.set("lang", "zh"); };

test("on a GitHub board a blocked worker comes first, then each pending card, which opens in place and hands the owner's answer to this repo's orchestrator", async () => {
  inChinese();
  const sends = [], focused = [], realTerminals = terminals;
  terminals = [...terminals, orchestrator];
  hcImpl = async (args) => { sends.push(args); return { code: 0, stdout: "", stderr: "" }; };
  runImpl = async (cmd, args) => { focused.push([cmd, args]); };
  try {
    const cx = runningSpawns;
    const view = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    assert.deepEqual(view.keys.slice(0, 4), ["card:0", "pending:#1536", "pending:#1472", "pending:#1428"]);
    assert.equal(after("待你决定", "issue 1536", "可能已定", "issue 1472", "去窗口聊", "issue 1428", "选一项",
      "卡片不全 1 张（#1280），正在退回编排者"), true);
    clicks.get("nawaban-row-pending:#1428")({}, cx);
    texts.length = 0;
    view.render(cx);
    for (const s of ["背景", "本机不跑推理", "最近进展", "建议", "B：两台都是自己的测评机", "就这么定", "不够，再说清楚", "GitHub 全文 →"]) assert.ok(texts.includes(s), s);
    assert.ok(texts.some((t) => t.endsWith("出分了")) && texts.includes("A · 一次性批准") && texts.includes("只管这一次"));
    assert.ok(!clicks.has("nawaban-settle-pending:#1428"), "就这么定 waits for an option");
    clicks.get("nawaban-option-pending:#1428-B")({}, cx);
    view.render(cx);
    clicks.get("nawaban-settle-pending:#1428")({}, cx);
    await settle();
    assert.deepEqual(sends, [["send", "t0", "[决策者经面板] #1428 选 B"]]);
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.cards.picked("#1428", "B")));
    view.onKey({ keystroke: "down" }, cx);
    view.selectedKey = "pending:#1536";
    view.onKey({ keystroke: "enter" }, cx);
    view.render(cx);
    clicks.get("nawaban-decided-pending:#1536")({}, cx);
    await settle();
    clicks.get("nawaban-row-pending:#1472")({}, cx);
    view.render(cx);
    clicks.get("nawaban-talk-pending:#1472")({}, cx);
    assert.deepEqual(sends.at(-1), ["send", "t0", "[决策者经面板] #1536 已定，请核实后记已决"]);
    assert.deepEqual(focused, [["agent.focus", { terminal: "t9" }]]);
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    runImpl = async () => {};
    stored.clear();
  }
});

test("with no live orchestrator for this repo the card's buttons are off and it says so; a failed hand-over says why and keeps the buttons", async () => {
  inChinese();
  clicks.clear();
  const realTerminals = terminals;
  try {
    const cx = runningSpawns;
    const view = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    clicks.get("nawaban-row-pending:#1428")({}, cx);
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.cards.noOrchestrator) && texts.includes("卡片不全 1 张（#1280），没有编排者窗口，还没退回"));
    assert.ok(!clicks.has("nawaban-unclear-pending:#1428"));
    terminals = [...realTerminals, orchestrator];
    hcImpl = async () => ({ code: 1, stdout: "", stderr: "no such terminal" });
    view.render(cx);
    clicks.get("nawaban-unclear-pending:#1428")({}, cx);
    await settle();
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.cards.failed("no such terminal")) && texts.includes("不够，再说清楚"));
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    stored.clear();
  }
});

test("incomplete cards go back to the orchestrator from the board read, once per card across reads and panels, and again after a failed send", async () => {
  inChinese();
  const sends = [], realTerminals = terminals;
  terminals = [...terminals, orchestrator];
  let answer = { code: 1, stdout: "", stderr: "busy" };
  hcImpl = async (args) => { sends.push(args); return answer; };
  execImpl = async (cmd, args = []) => {
    if (cmd === "git") return { code: 0, stdout: "/r/roubao/.git\n" };
    if (args[1] !== "json") return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify(args[2] === "board" ? cardsBoard : args[2] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
  };
  try {
    const cx = runningSpawns;
    const view = new NawabanBoard();
    view.init({}, cx);
    await settle();
    answer = { code: 0, stdout: "", stderr: "" };
    view.refresh(cx);
    await settle();
    view.refresh(cx);
    await settle();
    new NawabanBoard().init({}, cx);
    await settle();
    const returned = ["send", "t0", "[决策者经面板] 卡片不全，请按决策卡格式重写：#1280"];
    assert.deepEqual(sends, [returned, returned]);
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes("卡片不全 1 张（#1280），已退回编排者重写"));
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    execImpl = async () => ({ code: 1 });
    stored.clear();
  }
});

test("two panels reading at once return an incomplete card once; an answered card's issue with a new card gets its buttons back", async () => {
  inChinese();
  const sends = [], realTerminals = terminals;
  terminals = [...terminals, orchestrator];
  let release;
  hcImpl = (args) => { sends.push(args); return new Promise((r) => { release = () => r({ code: 0, stdout: "", stderr: "" }); }); };
  execImpl = async (cmd, args = []) => {
    if (cmd === "git") return { code: 0, stdout: "/r/roubao/.git\n" };
    if (args[1] !== "json") return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify(args[2] === "board" ? cardsBoard : args[2] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
  };
  try {
    const cx = runningSpawns;
    new NawabanBoard().init({}, cx);
    new NawabanBoard().init({}, cx);
    await settle();
    release();
    await settle();
    assert.equal(sends.length, 1);
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    const view = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    clicks.get("nawaban-row-pending:#1536")({}, cx);
    view.render(cx);
    clicks.get("nawaban-decided-pending:#1536")({}, cx);
    await settle();
    const later = { ...cardsBoard, columns: cardsBoard.columns.map((c) => c.key !== "open" ? c : { ...c, tasks: [pendingIssue(1536, 10, { ruled_after: true })] }) };
    view.board = later;
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes("对，已经定了") && !texts.includes(WINDOW_WORDS.zh.cards.closing("#1536")));
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    execImpl = async () => ({ code: 1 });
    stored.clear();
  }
});

test("a GitHub board is read from GitHub at most once a minute, whatever asks for it", async () => {
  const reads = [];
  execImpl = async (_cmd, args = []) => {
    if (args[1] !== "json") return { code: 1, stdout: "" };
    reads.push(args[2]);
    return { code: 0, stdout: JSON.stringify(args[2] === "board" ? ghBoard : args[2] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
  };
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const quiet = { spawn() {}, notify() {} };
    const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
    const settle = () => new Promise((r) => setImmediate(r));
    const boards = () => reads.filter((x) => x === "board").length;
    const view = new NawabanBoard();
    view.init({}, cx);
    await settle();
    assert.equal(boards(), 1);
    assert.equal(view.board.tracker, "github");
    clock += 30000;
    view.refresh(cx);
    await settle();
    assert.equal(boards(), 1);
    assert.equal(reads.filter((x) => x === "projects").length, 2);
    clock += 31000;
    view.refresh(cx);
    await settle();
    assert.equal(boards(), 2);
  } finally {
    Date.now = realNow;
    execImpl = async () => ({ code: 1 });
  }
});

test("a space on another machine is read there: the CLI under that machine's home, in the space's folder", async () => {
  const calls = [];
  execImpl = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const verb = args[args.indexOf("json") + 1];
    return { code: 0, stdout: JSON.stringify(verb === "board" ? ghBoard : { projects: [] }) };
  };
  where = { spaces: () => [{ id: "mbp/1", active: true, name: "roubao", folder: "/Users/v/roubao", machine: "mbp" }],
    focused: () => ({ space: "mbp/1", cwd: "/Users/v/roubao" }) };
  try {
    const quiet = { spawn() {}, notify() {} };
    const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
    const view = new NawabanBoard();
    view.init({}, cx);
    await new Promise((r) => setImmediate(r));
    const cli = calls.filter((c) => c.args.includes("json"));
    assert.ok(cli.length >= 2 && cli.every((c) => c.cmd === "sh" && c.args[1].includes('$HOME/nawaban/nawaban/cli.py')));
    assert.ok(calls.filter((c) => c.cmd !== "defaults" && !(c.cmd === "sh" && c.args[1].includes("LANG")))
      .every((c) => c.opts.on === "mbp" && c.opts.cwd === "/Users/v/roubao"));
    assert.ok(!cli.some((c) => c.args.includes("db")), "a remote board is polled, not watched");
    assert.equal(view.board.tracker, "github");
  } finally {
    where = here;
    execImpl = async () => ({ code: 1 });
  }
});

test("a project moved to the board is read with the board's CLI, every json verb; the rest with the old one", async () => {
  const calls = [];
  execImpl = async (cmd, args = [], opts = {}) => {
    if (cmd === "git") return { code: 0, stdout: `${opts.cwd}/.git\n` };
    calls.push([cmd, args[0], args[2]]);
    return { code: 0, stdout: JSON.stringify(args[2] === "board" ? board : args[2] === "db" ? { db: "/b/local.db" } : { projects: [{ name: "x" }] }) };
  };
  const quiet = { spawn() {}, notify() {} };
  const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    for (const moved of [false, true]) {
      if (moved) BOARD_PROJECTS.add("x");
      calls.length = 0;
      const view = new NawabanBoard();
      view.init({}, cx);
      await settle();
      const [cmd, cli] = moved ? ["node", "/h/nawaban/board/src/cli.ts"] : ["python3", "/h/nawaban/nawaban/cli.py"];
      assert.deepEqual(calls.filter(([c]) => c !== "defaults" && c !== "sh").sort(),
        ["board", "db", "okr", "projects"].map((v) => [cmd, cli, v]).sort());
      assert.equal(view.project, "x");
      assert.equal(view.db, "/b/local.db");
    }
  } finally {
    BOARD_PROJECTS.delete("x");
    execImpl = async () => ({ code: 1 });
  }
});

const okrFixture = JSON.parse(readFileSync(new URL("./okr.fixture.json", import.meta.url), "utf8"));

test("the OKR layer leads with the neediest Objective, lists only KRs not met, folds the met ones and an all-met Objective into one line", () => {
  stored.clear();
  const cx = cxOf(true);
  const view = drawn({ okr: okrFixture }, cx);
  const o = okrView(okrFixture, "zh");
  assert.ok(texts.includes(OKR_WORDS.zh.tally(o.met, o.total, o.measured)));
  assert.equal(after("听得懂需求", "2/5", "长对话换题多带旧条件", "84.6%", "/ 目标 ≤ 20%", "差 64.6 点", "· 11-19", "首字延迟", "超 160 ms",
    "误拦率", "未测 · 目标 ≤ 2%", "▸ 2 条已达标", "用户愿意拉人", "0/1", "推荐能减少筛选", "全部达标 1/1", "停了"), true);
  assert.ok(!texts.includes("长对话接着轮保留修饰") && !texts.includes("筛选次数下降"));
  const okrKeys = view.keys.filter((k) => k.startsWith("kr:") || k.startsWith("group:okr:"));
  assert.deepEqual(okrKeys, ["kr:0-0", "kr:0-1", "kr:0-2", "group:okr:听得懂需求", "kr:1-0", "group:okr:推荐能减少筛选"]);
  assert.ok(view.keys.indexOf("kr:0-0") > view.keys.indexOf("card:0") && view.keys.indexOf("kr:0-0") < view.keys.indexOf("group:stopped"));
  clicks.get("nawaban-group:okr:听得懂需求")({}, cx);
  texts.length = 0;
  view.render(cx);
  assert.equal(after("▾ 2 条已达标", "长对话接着轮保留修饰", "超 0.1 点", "意图准确率"), true);
  while (view.selectedKey !== "group:okr:推荐能减少筛选") view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "enter" }, cx);
  drawn({ okr: okrFixture }, cx);
  assert.equal(after("全部达标 1/1", "筛选次数下降", "超 1 点"), true, "a reopened panel keeps each fold");
  stored.clear();
});

test("json okr failing (no okr.toml, an older CLI) leaves the OKR section out and the board as it was", async () => {
  execImpl = async (_cmd, args = []) => {
    if (args[1] !== "json") return { code: 1, stdout: "" };
    if (args[2] === "okr") return { code: 2, stdout: "", stderr: "invalid choice: 'okr'" };
    return { code: 0, stdout: JSON.stringify(args[2] === "board" ? board : args[2] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
  };
  try {
    const quiet = { spawn() {}, notify() {} };
    const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
    const view = new NawabanBoard();
    view.okr = okrFixture;
    view.init({}, cx);
    await new Promise((r) => setImmediate(r));
    assert.equal(view.okr, null);
    assert.equal(view.error, null);
    assert.deepEqual(view.board, board);
  } finally {
    execImpl = async () => ({ code: 1 });
  }
});

test("a json okr that hangs holds up neither the board nor the next refresh, and is not asked twice", async () => {
  const reads = [];
  execImpl = (_cmd, args = [], opts = {}) => {
    if (args[1] !== "json") return Promise.resolve({ code: 1, stdout: "" });
    reads.push([args[2], opts.timeout]);
    if (args[2] === "okr") return new Promise(() => {});
    return Promise.resolve({ code: 0, stdout: JSON.stringify(args[2] === "board" ? board : args[2] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) });
  };
  try {
    const quiet = { spawn() {}, notify() {} };
    const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
    const settle = () => new Promise((r) => setImmediate(r));
    const view = new NawabanBoard();
    view.init({}, cx);
    await settle();
    assert.deepEqual(view.board, board);
    view.refresh(cx);
    await settle();
    assert.equal(reads.filter(([v]) => v === "board").length, 2);
    assert.deepEqual(reads.filter(([v]) => v === "okr"), [["okr", 5000]]);
    assert.equal(view.okr, null);
  } finally {
    execImpl = async () => ({ code: 1 });
  }
});

test("A, then B, then back to A: a late answer never overwrites a newer one, nor another space's", async () => {
  const asked = [];
  execImpl = (_cmd, args = [], opts = {}) => {
    if (args[1] !== "json") return Promise.resolve({ code: 1, stdout: "" });
    if (args[2] === "okr") return new Promise((r) => asked.push([opts.cwd, (x) => r({ code: 0, stdout: JSON.stringify(x) })]));
    return Promise.resolve({ code: 0, stdout: JSON.stringify(args[2] === "board" ? board : { projects: [] }) });
  };
  const at = (id) => ({ spaces: () => [{ id, active: true, name: id, folder: `/${id}` }], focused: () => ({ space: id, cwd: `/${id}` }) });
  const okrOf = (repo, tag) => ({ ...okrFixture, repo, def_commit: tag });
  try {
    const quiet = { spawn() {}, notify() {} };
    const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
    const settle = () => new Promise((r) => setImmediate(r));
    where = at("A");
    const view = new NawabanBoard();
    view.init({}, cx);
    await settle();
    where = at("B");
    view.refresh(cx);
    await settle();
    where = at("A");
    view.refresh(cx);
    await settle();
    assert.deepEqual(asked.map(([cwd]) => cwd), ["/A", "/B"]);
    assert.equal(view.okr, null);
    asked[1][1](okrOf("/b", "B1"));
    await settle();
    assert.equal(view.okr, null);
    asked[0][1](okrOf("/a", "A1"));
    await settle();
    assert.equal(view.okr.def_commit, "A1");
    view.refresh(cx);
    await settle();
    asked[2][1](okrOf("/a", "A2"));
    await settle();
    assert.equal(view.okr.def_commit, "A2");
    view.refresh(cx);
    await settle();
    view.okrFlight.set("|/A", view.okrGen + 1);
    asked[3][1](okrOf("/a", "A3-late"));
    await settle();
    assert.equal(view.okr.def_commit, "A2");
  } finally {
    where = here;
    execImpl = async () => ({ code: 1 });
  }
});

test("a project without okr.toml says it has no Objective yet, between 待你决定 and the tasks; any other failed read says nothing", async () => {
  const quiet = { spawn() {}, notify() {} };
  const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  const settle = () => new Promise((r) => setImmediate(r));
  const missing = JSON.stringify({ error: "没有 docs/agents/okr.toml:KR 定义写在仓库里,O 由决策者定、KR 由决策者点头" });
  const answers = { missing: { code: 1, stdout: missing }, older: { code: 2, stdout: "", stderr: "invalid choice: 'okr'" },
    refused: { code: 1, stdout: JSON.stringify({ error: "json okr 要在 git 仓库里跑,或给 --repo" }) } };
  try {
    for (const [why, answer] of Object.entries(answers)) {
      execImpl = async (_cmd, args = []) => {
        if (args[1] !== "json") return { code: 1, stdout: "" };
        if (args[2] === "okr") return answer;
        return { code: 0, stdout: JSON.stringify(args[2] === "board" ? board : args[2] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
      };
      for (const lang of ["zh", "en"]) {
        const view = new NawabanBoard();
        view.init({}, cx);
        await settle();
        view.lang = lang;
        texts.length = 0;
        view.render(cx);
        const said = OKR_WORDS[lang].noObjective;
        if (why !== "missing") { assert.ok(!texts.includes(said), why); continue; }
        assert.equal(after(WINDOW_WORDS[lang].decide, said, WINDOW_WORDS[lang].groups.stopped), true);
      }
    }
    assert.equal(OKR_WORDS.en.noObjective, "No Objective for this project yet");
    drawn({}, cxOf());
    assert.ok(!texts.includes(OKR_WORDS.zh.noObjective));
  } finally {
    execImpl = async () => ({ code: 1 });
  }
});

test("every element method the panel calls is in gpui-kit.d.ts", { skip: !dts && "no gpui-kit.d.ts on this machine" }, () => {
  const missing = [...called].filter((name) => !new RegExp(`\\b${name}\\??\\s*(\\(|<|:\\s*\\()`).test(dts));
  assert.deepEqual(missing, []);
});

test("an Objective row shows its ↑ ↓ = and a KR's hover card its 预期不符", () => {
  const okr = { ...okrFixture, objectives: [{ name: "O", impacts: { "↑": 2, "↓": 1, "=": 3 },
    krs: [{ name: "a", target: ">= 1", status: "missed", value: 0, mismatch: [{ ticket: "#5", dir: "↑" }] }] }] };
  drawn({ okr });
  for (const s of ["↑2 ↓1 =3", "预期不符 #5"]) assert.ok(texts.includes(s), s);
});
