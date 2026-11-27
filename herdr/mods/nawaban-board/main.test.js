import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { panelView, okrView, OKR_WORDS, WINDOW_WORDS, moreKey } from "./logic.js";

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
const ghBoard = { columns: [
  { key: "in_progress", tasks: [issue(239, { status: "in_progress", session: "gh-239", claimed_at: now - 600, progress: note("第 2 步") })] },
  { key: "open", tasks: [issue(256, { active_at: now - 3600 })] },
  { key: "done", tasks: [{ id: "#260", title: "issue 260", status: "done", parent: null, session: null, leader: null, terminal: null,
    claimed_at: null, created_at: 0, active_at: now - 600, done_at: now - 600 }] }] };
let execImpl = async () => ({ code: 1 });
let runImpl = async () => {};
let hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
const here = { spaces: () => [{ id: "here", active: true, name: "nawaban", folder: "/x" }], focused: () => ({ space: "here", cwd: "/x" }) };
let where = here;

let captureInput = null;
const inputState = () => {
  const handlers = {};
  let value = "";
  captureInput = { on: (event, h) => { handlers[event] = h; return true; }, fire: (event, cx) => handlers[event]({}, cx),
    value: () => value, set_value: (next) => { value = next; }, type: (next) => { value = next; } };
  return captureInput;
};

const stubs = {
  "gpui-kit": { View: class {}, div: make("div"), svg: make("svg") },
  "gpui-base": { v_flex: make("v_flex"), h_flex: make("h_flex"), Popover: el, HoverCard: el, InputState: { new: inputState }, Input: { new: () => el } },
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
const { default: NawabanBoard, krFill } = await import("./main.js");

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

test("each tab draws only its own part: 待决 the waiting cards, OKR the reading, 任务 停滞 进行中 待办 已完成, in Chinese and English, with Herdr's API only", () => {
  const v = panelView({ agents, terminals, space: "here", board, now, lang: "zh" });
  assert.deepEqual(v.waiting.map((c) => c.focus), ["t3"]);
  assert.deepEqual(v.tasks.map((g) => [g.group, g.items.map((i) => i.id)]),
    [["stopped", ["GONE"]], ["working", ["CUR", "GH", "S"]], ["todo", ["TODO"]], ["done", ["DONE"]]]);
  stored.clear();
  for (const lang of ["zh", "en"]) {
    stored.clear();
    const view = drawn({ lang, okr: okrFixture });
    const w = WINDOW_WORDS[lang], o = OKR_WORDS[lang], v = okrView(okrFixture, lang);
    assert.equal(after(w.tabs.decide, w.tabs.okr, w.tabs.tasks, "放行吗？"), true, lang);
    assert.ok(!texts.includes("听得懂需求") && !texts.includes(w.groups.stopped));
    assert.ok(!texts.includes(w.go), "去窗口 waits for a hover or a selection");
    view.pickTab("okr");
    texts.length = 0;
    view.render(cxOf());
    assert.equal(after(o.tally(v.met, v.total, v.measured), "听得懂需求"), true, lang);
    assert.ok(!texts.includes("放行吗？"));
    view.pickTab("tasks");
    texts.length = 0;
    view.render(cxOf());
    assert.equal(after(w.groups.stopped, w.groups.working, w.groups.todo, w.groups.done), true, lang);
  }
  const opened = drawn();
  clicks.get("nawaban-group:working")({}, cxOf());
  opened.render(cxOf());
  stored.clear();
  assert.ok(called.has("loop") && called.has("on_hover") && called.has("trigger"), "the dots breathe and the rows carry hover cards");
});

test("任务 opens 停滞 and 进行中, folds 待办 and 已完成; Enter or a click on a header folds and opens it, and a reopened panel keeps each choice and the tab per project", () => {
  stored.clear();
  const cx = cxOf(true);
  const view = drawn({}, cx);
  assert.deepEqual(view.keys, ["card:0"]);
  view.onKey({ keystroke: "3" }, cx);
  view.render(cx);
  assert.deepEqual(view.keys, ["group:stopped", "task:GONE", "group:working", "task:CUR", "task:GH", "task:S", "group:todo", "group:done"]);
  while (view.selectedKey !== "group:working") view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "enter" }, cx);
  view.render(cx);
  assert.deepEqual(view.keys.slice(2, 4), ["group:working", "group:todo"]);
  clicks.get("nawaban-group:todo")({}, cx);
  view.render(cx);
  const folded = ["group:stopped", "task:GONE", "group:working", "group:todo", "task:TODO", "group:done"];
  assert.deepEqual(view.keys, folded);
  assert.deepEqual(drawn({}, cx).keys, folded);
  assert.deepEqual(drawn({ project: "other" }, cx).keys, ["card:0"]);
  stored.clear();
});

test("four text tabs carry their badges; ← → and 1 2 3 4 switch them; the first time it opens on 待决 if something waits, else OKR", () => {
  stored.clear();
  const cx = cxOf(true);
  const view = drawn({ okr: okrFixture }, cx);
  assert.equal(after("待决", "1", "OKR", "1", "任务", "5", "放行吗？"), true);
  view.onKey({ keystroke: "right" }, cx);
  view.render(cx);
  assert.ok(view.keys.every((k) => k.startsWith("kr:") || k.startsWith("group:okr")));
  view.onKey({ keystroke: "right" }, cx);
  view.onKey({ keystroke: "right" }, cx);
  view.render(cx);
  assert.equal(view.tab, "capture");
  view.onKey({ keystroke: "left" }, cx);
  view.onKey({ keystroke: "left" }, cx);
  view.render(cx);
  assert.equal(view.tab, "okr");
  view.onKey({ keystroke: "1" }, cx);
  view.render(cx);
  assert.deepEqual(view.keys, ["card:0"]);
  view.onKey({ keystroke: "2" }, cx);
  assert.equal(drawn({ okr: okrFixture }, cx).tab, "okr", "the owner's pick wins over a waiting card");
  assert.equal(drawn({ project: "other", okr: okrFixture }, cx).tab, "decide");
  stored.clear();
  assert.equal(drawn({ board: { columns: [] }, okr: okrFixture }, cx).tab, "okr");
  stored.clear();
});

test("已完成 shows its newest 3, then 再显示 N 条; Enter on it shows all and 收起, remembered when the panel opens again", () => {
  stored.clear();
  const cx = cxOf(true);
  const done = (i) => ({ id: "D" + i, title: "done " + i, status: "done", parent: null, session: null, terminal: null, claimed_at: 1,
    created_at: 0, active_at: now - 60 * i, done_at: now - 60 * i });
  const many = { columns: [...board.columns.filter((c) => c.key !== "done"), { key: "done", tasks: Array.from({ length: 8 }, (_, i) => done(i)) }] };
  const view = drawn({ board: many }, cx);
  view.pickTab("tasks");
  view.render(cx);
  clicks.get("nawaban-group:done")({}, cx);
  view.render(cx);
  assert.deepEqual(view.keys.slice(-5), ["group:done", "task:D0", "task:D1", "task:D2", moreKey("done")]);
  texts.length = 0;
  view.render(cx);
  assert.ok(texts.includes("再显示 5 条"));
  while (view.selectedKey !== moreKey("done")) view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "enter" }, cx);
  texts.length = 0;
  view.render(cx);
  assert.ok(texts.includes("收起"));
  assert.equal(view.keys.filter((k) => k.startsWith("task:D")).length, 8);
  const reopened = drawn({ board: many }, cx);
  assert.equal(reopened.keys.filter((k) => k.startsWith("task:D")).length, 8);
  clicks.get("nawaban-more-done")({}, cx);
  reopened.render(cx);
  assert.equal(reopened.keys.filter((k) => k.startsWith("task:D")).length, 3);
  stored.clear();
});

test("a waiting window's question is its card's main line; a held task row reads 在做 with its step line, todo and done stay one line", () => {
  stored.clear();
  const view = drawn({}, cxOf());
  const row = (key) => view.selectableByKey.get(key);
  assert.equal(row("card:0").title, "放行吗？");
  assert.ok(["task:GONE", "task:CUR", "task:GH"].every((k) => row(k).title.startsWith("【在做】") && row(k).title.endsWith("编排者代定")));
  assert.match(row("task:CUR").why, /^\[开工\] → 首次改文件 → 首次提交 · /);
  assert.deepEqual(["task:TODO", "task:DONE"].map((k) => row(k).why), [null, null]);
  stored.clear();
});

test("去窗口 takes the place of the time while a row is hovered or selected, and goes there; a selected row opens its details below it with the keyboard", () => {
  stored.clear();
  const focused = [];
  runImpl = async (cmd, args) => { focused.push([cmd, args]); };
  try {
    const cx = cxOf(true);
    const view = drawn({}, cx);
    view.pickTab("tasks");
    view.render(cx);
    hovers.get("nawaban-row-task:GONE")(true, cx);
    assert.equal(view.hovered, "task:GONE");
    texts.length = 0;
    view.render(cx);
    assert.ok(!texts.includes(WINDOW_WORDS.zh.go), "GONE has no window to go to");
    view.pickTab("decide");
    view.render(cx);
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
  options: [{ key: "A", text: "一次性批准", note: "只管这一次" }, { key: "B", text: "加进白名单", note: "以后都放｜two-way" }] };
const pendingIssue = (n, at, x) => issue(n, { url: "https://gh/" + n,
  pending: { brief: "待决：…", at: now - at, progress: [{ body: "出分了", at: now - at + 60 }], card: { ...cardOf, decision: "放不放行 " + n },
    talk: null, ruled_after: false, ...x } });
const cardsBoard = { ...ghBoard, columns: ghBoard.columns.map((c) => c.key !== "open" ? c : { ...c, tasks: [
  pendingIssue(1428, 3000), pendingIssue(1536, 5000, { ruled_after: true }), pendingIssue(1472, 4000, { talk: { window: "t9" } }),
  pendingIssue(1280, 2000, { card: null })] }) };
const orchestrator = { address: "t0", name: null, parent: null, status: "done", state: "live", cwd: "/r/roubao", labels: { role: "orchestrator" } };
const runningSpawns = { spawn: (f) => f({ spawn() {}, notify() {} }), notify() {}, stop_propagation() {}, timer: { every() {} },
  focus_handle: () => ({ is_focused: () => false, focus() {} }) };
const settle = () => new Promise((r) => setImmediate(r));
const inChinese = () => { stored.clear(); stored.set("lang", "zh"); };

test("each pending card opens in place and hands the owner's answer to this repo's orchestrator", async () => {
  inChinese();
  const sends = [], focused = [], realTerminals = terminals;
  terminals = [...terminals, orchestrator];
  hcImpl = async (args) => { sends.push(args); return { code: 0, stdout: "", stderr: "" }; };
  runImpl = async (cmd, args) => { focused.push([cmd, args]); };
  try {
    const cx = runningSpawns;
    const view = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    assert.deepEqual(view.keys.slice(0, 3), ["pending:#1536", "pending:#1472", "pending:#1428"]);
    assert.equal(after("待决", "3", "可能已定", "放不放行 1536", "去窗口聊", "放不放行 1472", "选一项", "放不放行 1428",
      "未就绪 1 件（#1280），正在退回编排者"), true);
    clicks.get("nawaban-row-pending:#1428")({}, cx);
    texts.length = 0;
    view.render(cx);
    for (const s of ["背景", "本机不跑推理", "最新进展", "建议", "B：两台都是自己的测评机", "就这么定", "不够，再说清楚", "GitHub 全文 →"]) assert.ok(texts.includes(s), s);
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
    assert.deepEqual(sends.at(-1), ["send", "t0", "[决策者经面板] #1536 已定，请核实后记已决（决策记录）"]);
    assert.deepEqual(focused, [["agent.focus", { terminal: "t9" }]]);
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    runImpl = async () => {};
    stored.clear();
  }
});

test("every card in the 待决 tab, whatever its kind, opens to the whole card in order, then its own buttons and the GitHub text", () => {
  inChinese();
  clicks.clear();
  const realTerminals = terminals;
  terminals = [...terminals, orchestrator];
  try {
    const cx = runningSpawns;
    const noProgress = { ...cardsBoard, columns: cardsBoard.columns.map((c) => c.key !== "open" ? c
      : { ...c, tasks: c.tasks.map((t) => t.id === "#1472" ? { ...t, pending: { ...t.pending, progress: [] } } : t) }) };
    const view = drawn({ board: noProgress, repo: "/r/roubao" }, cx);
    const buttons = { "#1428": ["就这么定", "不够，再说清楚"], "#1536": ["对，已经定了", "还没定"], "#1472": ["去 t9 窗口"] };
    for (const [id, own] of Object.entries(buttons)) {
      clicks.get("nawaban-row-pending:" + id)({}, cx);
      texts.length = 0;
      view.render(cx);
      const progress = id === "#1472" ? "还没有进展" : texts.find((t) => t.endsWith("出分了"));
      assert.equal(after("放不放行 " + id.slice(1), "决策事项", "长对话接着轮保留全部修饰", "关联 KR", "本机不跑推理", "背景", progress, "最新进展",
        "A · 一次性批准", "只管这一次", "B · 加进白名单", "以后都放｜two-way", "建议", "B：两台都是自己的测评机", ...own, "GitHub 全文 →"), true, id);
      clicks.get("nawaban-row-pending:" + id)({}, cx);
    }
    assert.ok(!clicks.has("nawaban-option-pending:#1536-A") && !clicks.has("nawaban-option-pending:#1472-A"), "only a pick card's options are picked");
  } finally {
    terminals = realTerminals;
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
    assert.ok(texts.includes(WINDOW_WORDS.zh.cards.noOrchestrator) && texts.includes("未就绪 1 件（#1280），没有编排者窗口，还没退回"));
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
    if (args[3] !== "json") return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify(args[4] === "board" ? cardsBoard : args[4] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
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
    const returned = ["send", "t0", "[决策者经面板] 待决未就绪（不满足就绪标准），请按待决策项格式重写：#1280"];
    assert.deepEqual(sends, [returned, returned]);
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes("未就绪 1 件（#1280），已退回编排者重写"));
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
    if (args[3] !== "json") return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify(args[4] === "board" ? cardsBoard : args[4] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
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
    assert.ok(cli.length >= 2 && cli.every((c) => c.cmd === "sh" && c.args[1].includes('$HOME/.local/bin/nawaban')));
    assert.ok(calls.filter((c) => c.cmd !== "defaults" && !(c.cmd === "sh" && c.args[1].includes("LANG")))
      .every((c) => c.opts.on === "mbp" && c.opts.cwd === "/Users/v/roubao"));
    assert.ok(!cli.some((c) => c.args.includes("db")), "a remote board is polled, not watched");
    assert.deepEqual(view.board, ghBoard);
  } finally {
    where = here;
    execImpl = async () => ({ code: 1 });
  }
});

test("the panel reads every json verb with the board CLI", async () => {
  const calls = [];
  execImpl = async (cmd, args = []) => {
    if (cmd === "git") return { code: 0, stdout: "/Users/v/x/.git\n" };
    calls.push([cmd, args[3], args[4]]);
    return { code: 0, stdout: JSON.stringify(args[4] === "board" ? board : args[4] === "db" ? { db: "/b/local.db" } : { projects: [{ name: "x" }] }) };
  };
  const quiet = { spawn() {}, notify() {} };
  const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  where = { spaces: () => [{ id: "here", active: true, name: "x", folder: "/Users/v/x" }], focused: () => ({ space: "here", cwd: "/Users/v/x" }) };
  try {
    const view = new NawabanBoard();
    view.init({}, cx);
    for (let i = 0; i < 200 && calls.length < 4; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(calls.filter(([c, json]) => c !== "defaults" && json === "json").sort(),
      ["board", "db", "okr", "projects"].map((v) => ["sh", "json", v]).sort());
  } finally {
    where = here;
    execImpl = async () => ({ code: 1 });
  }
});

const okrFixture = JSON.parse(readFileSync(new URL("./okr.fixture.json", import.meta.url), "utf8"));

test("the OKR tab opens with the tally, leads with the neediest Objective, lists missed and stale KRs, folds the untested and the met ones and an all-met Objective into one line", () => {
  stored.clear();
  const cx = cxOf(true);
  const view = drawn({ okr: okrFixture }, cx);
  view.pickTab("okr");
  texts.length = 0;
  view.render(cx);
  const o = okrView(okrFixture, "zh");
  assert.equal(after(OKR_WORDS.zh.tally(o.met, o.total, o.measured), "听得懂需求", "2/5", "长对话换题多带旧条件", "84.6%", "/ 目标 ≤ 20%", "· 偏差", "-64.6 点", "红", "· 截至 11-19",
    "首字延迟", "+160.0 ms", "黄", "▸ 1 条未测", "▸ 2 条已达标", "用户愿意拉人", "0/1", "▸ 1 条未测", "推荐能减少筛选", "全部达标 1/1"), true);
  assert.ok(!texts.includes("误拦率") && !texts.includes("长对话接着轮保留修饰") && !texts.includes("筛选次数下降") && !texts.includes("停滞"));
  assert.deepEqual(view.keys, ["kr:0-0", "kr:0-1", "group:okr-untested:听得懂需求", "group:okr:听得懂需求",
    "group:okr-untested:用户愿意拉人", "group:okr:推荐能减少筛选"]);
  clicks.get("nawaban-group:okr:听得懂需求")({}, cx);
  clicks.get("nawaban-group:okr-untested:听得懂需求")({}, cx);
  texts.length = 0;
  view.render(cx);
  assert.equal(after("▾ 1 条未测", "误拦率", "未测 / 目标 ≤ 2%", "▾ 2 条已达标", "长对话接着轮保留修饰", "+0.1 点", "绿", "意图准确率"), true);
  assert.deepEqual(view.keys.slice(0, 7), ["kr:0-0", "kr:0-1", "group:okr-untested:听得懂需求", "kr:0-2", "group:okr:听得懂需求", "kr:0-3", "kr:0-4"]);
  while (view.selectedKey !== "group:okr:推荐能减少筛选") view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "enter" }, cx);
  drawn({ okr: okrFixture }, cx);
  assert.equal(after("全部达标 1/1", "筛选次数下降", "+1.0 点"), true, "a reopened panel keeps the tab and each fold");
  stored.clear();
});

test("json okr failing (no okr.toml, an older CLI) leaves the OKR section out and the board as it was", async () => {
  execImpl = async (_cmd, args = []) => {
    if (args[3] !== "json") return { code: 1, stdout: "" };
    if (args[4] === "okr") return { code: 2, stdout: "", stderr: "invalid choice: 'okr'" };
    return { code: 0, stdout: JSON.stringify(args[4] === "board" ? board : args[4] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
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
    if (args[3] !== "json") return Promise.resolve({ code: 1, stdout: "" });
    reads.push([args[4], opts.timeout]);
    if (args[4] === "okr") return new Promise(() => {});
    return Promise.resolve({ code: 0, stdout: JSON.stringify(args[4] === "board" ? board : args[4] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) });
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
    if (args[3] !== "json") return Promise.resolve({ code: 1, stdout: "" });
    if (args[4] === "okr") return new Promise((r) => asked.push([opts.cwd, (x) => r({ code: 0, stdout: JSON.stringify(x) })]));
    return Promise.resolve({ code: 0, stdout: JSON.stringify(args[4] === "board" ? board : { projects: [] }) });
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

test("a project without okr.toml says in the OKR tab it has no Objective yet; any other failed read says nothing", async () => {
  const quiet = { spawn() {}, notify() {} };
  const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  const settle = () => new Promise((r) => setImmediate(r));
  const missing = JSON.stringify({ error: "没有 docs/agents/okr.toml:KR 定义写在仓库里,O 由决策者定、KR 由决策者点头" });
  const answers = { missing: { code: 1, stdout: missing }, older: { code: 2, stdout: "", stderr: "invalid choice: 'okr'" },
    refused: { code: 1, stdout: JSON.stringify({ error: "json okr 要在 git 仓库里跑,或给 --repo" }) } };
  try {
    for (const [why, answer] of Object.entries(answers)) {
      execImpl = async (_cmd, args = []) => {
        if (args[3] !== "json") return { code: 1, stdout: "" };
        if (args[4] === "okr") return answer;
        return { code: 0, stdout: JSON.stringify(args[4] === "board" ? board : args[4] === "db" ? { db: "/b/nawaban.db" } : { projects: [] }) };
      };
      for (const lang of ["zh", "en"]) {
        const view = new NawabanBoard();
        view.init({}, cx);
        await settle();
        view.lang = lang;
        view.pickTab("okr");
        texts.length = 0;
        view.render(cx);
        const said = OKR_WORDS[lang].noObjective;
        if (why !== "missing") { assert.ok(!texts.includes(said), why); continue; }
        assert.equal(after(WINDOW_WORDS[lang].tabs.okr, said), true);
        assert.ok(!texts.includes(WINDOW_WORDS[lang].groups.stopped));
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

test("an Objective row leaves out the ↑ ↓ = tally; a KR's hover card keeps its 预期不符", () => {
  const okr = { ...okrFixture, objectives: [{ name: "O", impacts: { "↑": 2, "↓": 1, "=": 3 },
    krs: [{ name: "a", target: ">= 1", status: "missed", value: 0, mismatch: [{ ticket: "#5", dir: "↑" }] }] }] };
  stored.clear();
  const view = drawn({ okr });
  view.pickTab("okr");
  texts.length = 0;
  view.render(cxOf());
  assert.ok(!texts.some((s) => s.includes("↑2")) && texts.includes("预期不符 #5"));
  stored.clear();
});

test("a tab pick is kept even on the tab already shown, never before the board is read, and Enter never acts on a row of a hidden tab", () => {
  stored.clear();
  const cx = cxOf(true);
  const empty = drawn({ board: { columns: [] }, okr: okrFixture }, cx);
  assert.equal(empty.tab, "okr");
  empty.onKey({ keystroke: "2" }, cx);
  assert.equal(drawn({ okr: okrFixture }, cx).tab, "okr", "picking the shown tab still counts");
  stored.clear();
  const loading = drawn({ board: null }, cx);
  loading.onKey({ keystroke: "3" }, cx);
  assert.equal(stored.get("tab"), undefined);
  stored.clear();
  const view = drawn({}, cx);
  view.pickTab("tasks");
  view.render(cx);
  while (view.selectedKey !== "group:working") view.onKey({ keystroke: "down" }, cx);
  view.project = "B";
  view.pickedTabs = { B: "okr" };
  view.render(cx);
  view.onKey({ keystroke: "enter" }, cx);
  assert.equal(stored.get("folds"), undefined);
  stored.clear();
});

test("a KR's bar fills by value against target, the other way round when lower is better, and is left out with no number to compare", () => {
  const kr = (value, target, measured = true) => ({ value, target, measured });
  assert.equal(krFill(kr("45%", "≥ 90%")), 0.5);
  assert.equal(krFill(kr("97.5%", "≥ 95%")), 1);
  assert.equal(krFill(kr("84.6%", "≤ 20%")), 20 / 84.6);
  assert.equal(krFill(kr("640ms", "< 800ms")), 1);
  assert.equal(krFill(kr("未测", "≥ 5%", false)), null);
  assert.equal(krFill(kr("3", "上线")), null);
  assert.equal(krFill(kr("1", "完成 2 项验收后上线")), null);
  assert.equal(krFill(kr("-2", "≥ 0")), 0);
});

test("收件箱 keeps what is typed on Enter per project, hands it to this repo's orchestrator, sinks it as 已交 into a folded group, and keeps it on a failed send", async () => {
  inChinese();
  clicks.clear();
  const sends = [], realTerminals = terminals;
  try {
    const cx = runningSpawns;
    const view = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    view.pickTab("capture");
    captureInput.type("  \n ");
    captureInput.fire("submit", cx);
    assert.equal(stored.get("capture:nawaban"), undefined);
    captureInput.type("  改一下 hook  ");
    captureInput.fire("submit", cx);
    assert.equal(captureInput.value(), "");
    const [item] = JSON.parse(stored.get("capture:nawaban"));
    assert.equal(item.text, "改一下 hook");
    texts.length = 0;
    view.render(cx);
    assert.equal(after("收件箱", "1", "改一下 hook", "没有编排者", "交给编排者", "删除"), true);
    assert.ok(!clicks.has("nawaban-capture-hand-" + item.id), "no orchestrator, no hand-over");
    captureInput.fire("focus", cx);
    view.onKey({ keystroke: "1" }, cx);
    assert.equal(view.tab, "capture", "typing in the box never switches tabs");
    captureInput.fire("blur", cx);
    terminals = [...realTerminals, orchestrator];
    hcImpl = async () => ({ code: 1, stdout: "", stderr: "no such terminal" });
    view.render(cx);
    clicks.get("nawaban-capture-hand-" + item.id)({}, cx);
    await settle();
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.cards.failed("no such terminal")) && texts.includes("改一下 hook") && texts.includes("交给编排者"));
    let answer;
    hcImpl = (args) => { sends.push(args); return new Promise((r) => { answer = r; }); };
    const other = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    clicks.get("nawaban-capture-hand-" + item.id)({}, cx);
    other.handCapture(item, "t0", cx);
    view.render(cx);
    assert.equal(sends.length, 1, "one hand-over at a time across panels");
    answer({ code: 0, stdout: "", stderr: "" });
    await settle();
    other.handCapture(item, "t0", cx);
    await settle();
    assert.deepEqual(sends, [["send", "t0", "[决策者经面板] 收件箱：改一下 hook。请转成任务或命令，回我结果"]]);
    const reopened = drawn({ board: cardsBoard, repo: "/r/roubao" }, cx);
    assert.equal(reopened.tab, "capture");
    assert.ok(texts.includes("▸ 已交 1") && !texts.includes("改一下 hook") && !texts.includes(WINDOW_WORDS.zh.cards.failed("no such terminal")));
    clicks.get("nawaban-group:captureHanded")({}, cx);
    texts.length = 0;
    reopened.render(cx);
    assert.ok(texts.includes("改一下 hook") && texts.some((t) => /^已交 \d\d-\d\d \d\d:\d\d$/.test(t)));
    clicks.get("nawaban-capture-remove-" + item.id)({}, cx);
    assert.deepEqual(JSON.parse(stored.get("capture:nawaban")), []);
    stored.set("capture:other", "{broken");
    texts.length = 0;
    drawn({ board: cardsBoard, project: "other", pickedTabs: { other: "capture" } }, cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.capture.empty));
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    stored.clear();
  }
});

test("a CLI that crashes shows its Error line, not node's closing version line", async () => {
  const quiet = { spawn() {}, notify() {} };
  const cx = { spawn: (f) => { f(quiet); }, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  const stderr = "node:internal/modules/package_json_reader:331\n  throw new ERR_MODULE_NOT_FOUND(...);\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml'\n    at x\n\nNode.js v26.8.1\n";
  execImpl = async (_cmd, args = []) => (args[3] === "json" ? { code: 1, stdout: "", stderr } : { code: 1, stdout: "" });
  try {
    const view = new NawabanBoard();
    view.init({}, cx);
    await new Promise((r) => setImmediate(r));
    assert.equal(view.error, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml'");
  } finally {
    execImpl = async () => ({ code: 1 });
  }
});

test("a 等你 card whose window is gone opens in place to its whole question, and hands a reply or a send-back to this repo's orchestrator", async () => {
  inChinese();
  clicks.clear();
  const sends = [], realTerminals = terminals;
  terminals = [...terminals, orchestrator];
  hcImpl = async (args) => { sends.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const asked = "要不要把 Office 名牌接上 nawaban 票号和进展？\n不急，可不做";
  const waits = { columns: [{ key: "in_progress", tasks: [open("NAWABAN-OFFICE-LINK", { status: "in_progress", title: "Office 布局名牌显示 worker 在做的票",
    session: "W", leader: "W", terminal: "closed", claimed_at: now - 4 * 86400, active_at: now - 3 * 86400, waiting: asked })] }] };
  try {
    const cx = runningSpawns;
    const view = drawn({ board: waits, repo: "/r/roubao" }, cx);
    const row = "nawaban-row-card:0";
    assert.ok(clicks.has(row), "the card can be clicked");
    clicks.get(row)({}, cx);
    texts.length = 0;
    view.render(cx);
    for (const s of [asked, "答复", "不够，再说清楚"]) assert.ok(texts.includes(s), s);
    captureInput.type("  接上，先只读  ");
    clicks.get("nawaban-reply-card:0")({}, cx);
    await settle();
    assert.deepEqual(sends, [["send", "t0", "[决策者经面板] NAWABAN-OFFICE-LINK 答复：接上，先只读"]]);
    texts.length = 0;
    view.render(cx);
    assert.ok(texts.includes(WINDOW_WORDS.zh.cards.replied("NAWABAN-OFFICE-LINK")));
    const other = drawn({ board: waits, repo: "/r/roubao" }, cx);
    clicks.get(row)({}, cx);
    other.render(cx);
    clicks.get("nawaban-unclear-card:0")({}, cx);
    await settle();
    assert.deepEqual(sends.at(-1), ["send", "t0", "[决策者经面板] NAWABAN-OFFICE-LINK 背景不够，请补写后重发待决"]);
  } finally {
    terminals = realTerminals;
    hcImpl = async () => ({ code: 0, stdout: "", stderr: "" });
    stored.clear();
  }
});
