// Render smoke test: main.js's view drawn against stand-ins for Herdr's "gpui-kit", "gpui-base" and
// "herdr" modules, which record every element method called. Each name must exist in Herdr's API,
// gpui-kit.d.ts, which herdr-app writes into ~/.config/herdr-app and into a mod folder it loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { leadersView } from "./logic.js";

const called = new Set();
let onSize = null;
// An element: any method records its name and returns the element. `when` and `hover` run their
// builder, as gpui does, so the branches they add are drawn too.
const el = new Proxy({}, {
  get: (_, name) => typeof name === "symbol" ? undefined : (...args) => {
    called.add(name);
    if (name === "when") return args[0] ? args[1](el) : el;
    if (name === "hover") args[0](el);
    if (name === "on_size_change") onSize = args[0];
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
// Herdr's tree: t6 started two workers with `hc run`; they have no pane, so no AgentInfo.
const kid = (address, name, status) => ({ address, name, parent: "t6", status, state: "live" });
const terminals = [...agents.map((a) => ({ address: a.address, name: null, parent: null, status: a.status, state: "live" })),
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

// The same space on a GitHub-tracked project: t6's children are issues by their gh-<n> names.
const issue = (n, x) => open(`#${n}`, { title: `issue ${n}`, ...x });
const ghBoard = { tracker: "github", columns: [
  { key: "in_progress", tasks: [issue(239, { status: "in_progress", session: "gh-239", claimed_at: now - 600, progress: note("第 2 步") })] },
  { key: "open", tasks: [issue(256, { active_at: now - 3600 })] },
  { key: "done", tasks: [{ id: "#260", title: "issue 260", status: "done", parent: null, session: null, leader: null, terminal: null,
    claimed_at: null, created_at: 0, active_at: now - 600, done_at: now - 600 }] }] };
let execImpl = async () => ({ code: 1 });

const stubs = {
  "gpui-kit": { View: class {}, div: make("div"), svg: make("svg") },
  "gpui-base": { v_flex: make("v_flex"), h_flex: make("h_flex"), Popover: el, HoverCard: el, Collapsible: el },
  herdr: { spaces: () => [{ id: "here", active: true, name: "nawaban", folder: "/x" }], focused: () => ({ space: "here", cwd: "/x" }),
    agents: () => agents, terminals: () => terminals, theme: () => new Proxy({}, { get: () => "#808080" }), home: () => "/h",
    run: async () => {}, exec: (...a) => execImpl(...a), nextCommand: () => new Promise(() => {}), watchFolder: () => new Promise(() => {}), props: () => null, closeOverlay: () => null },
};
globalThis.__nawabanStubs = stubs;
registerHooks({
  resolve: (specifier, context, next) => specifier in stubs ? { url: `stub:${specifier}`, shortCircuit: true } : next(specifier, context),
  load: (url, context, next) => !url.startsWith("stub:") ? next(url, context) : { format: "module", shortCircuit: true,
    source: Object.keys(stubs[url.slice(5)]).map((k) => `export const ${k} = globalThis.__nawabanStubs[${JSON.stringify(url.slice(5))}].${k};`).join("\n") },
});
const { default: NawabanBoard } = await import("./main.js");

const dts = [`${homedir()}/.config/herdr-app/gpui-kit.d.ts`, new URL("./gpui-kit.d.ts", import.meta.url)]
  .map((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }).find(Boolean);

test("the panel draws every item state, at 420 and 380 px, in Chinese and English, with Herdr's API only", () => {
  // the fixture covers what the panel can show
  const v = leadersView({ agents, terminals, space: "here", board, now, lang: "zh" });
  const items = v.groups.flatMap((g) => g.items);
  // a leader terminal's group: a child holding a task, under its Herdr name, and one holding none
  assert.deepEqual(v.groups.find((g) => g.leader === "t6")?.items.map((i) => [i.title, i.name]), [["GH 的标题", "gh-239"], ["gh-256", "gh-256"], ["gh-260", "gh-260"]]);
  assert.deepEqual(new Set(items.map((i) => i.state)), new Set(["done", "current", "stopped", "todo", "waiting"]));
  assert.ok(items.some((i) => i.gone) && items.some((i) => i.spec) && v.groups.some((g) => g.decision));
  assert.ok(v.waiting.length && v.idle.count);
  const cx = { spawn() {}, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  for (const lang of ["zh", "en"]) {
    for (const width of [420, 380]) {
      const view = new NawabanBoard();
      view.init({}, cx);
      Object.assign(view, { lang, board });
      view.render(cx);
      onSize({ width }, cx);
      assert.equal(view.narrow, width < 400);
      view.render(cx);
    }
  }
  assert.ok(called.has("loop") && called.has("on_click"), "the items' branches were drawn");
});

test("on a GitHub board the panel draws issue titles, 在推, and the 已关 row folded and open", () => {
  const v = leadersView({ agents, terminals, space: "here", board: ghBoard, now, lang: "zh" });
  const g = v.groups.find((x) => x.leader === "t6");
  assert.deepEqual(g.items.map((i) => [i.title, i.name, i.state]), [["issue 239", "gh-239", "current"], ["issue 256", "gh-256", "pushing"]]);
  assert.deepEqual(g.closed.map((i) => [i.title, i.state]), [["issue 260", "done"]]);
  const cx = { spawn() {}, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  // with pending decisions and an objective of seven lines: closed and open, the windows folded and not
  const recent = Array.from({ length: 7 }, (_, i) => ({ task: "#239", at: now - i, line: `进展：第 ${i} 步` }));
  const pending = { brief: "待决：发吗？\n【推荐】A。\n【默认动作】按推荐执行", at: now - 3600, default_action: "按推荐执行", due: true };
  const withObjectives = { ...ghBoard, objectives: [{ id: "#600", title: "上线", intent: "排期 1.1", metric: "0 起", url: "u", recent }],
    columns: ghBoard.columns.map((c) => c.key !== "open" ? c : { ...c, tasks: c.tasks.map((x) => ({ ...x, objective: "#600", pending })) }) };
  for (const unfold of [false, true]) {
    for (const board of [ghBoard, withObjectives]) {
      const view = new NawabanBoard();
      view.init({}, cx);
      Object.assign(view, { lang: "zh", board, windowsOpen: unfold, openPending: unfold ? "#256" : null });
      if (unfold) { view.unfolded.add("t6"); view.openObjectives.add("#600"); }
      view.render(cx);
    }
  }
  assert.ok(called.has("content") && called.has("open"));
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
    clock += 30000; // a window changed state, the board file changed: the last board serves
    view.refresh(cx);
    await settle();
    assert.equal(boards(), 1);
    assert.equal(reads.filter((x) => x === "projects").length, 2); // the local board still is read
    clock += 31000;
    view.refresh(cx);
    await settle();
    assert.equal(boards(), 2);
  } finally {
    Date.now = realNow;
    execImpl = async () => ({ code: 1 });
  }
});

test("every element method the panel calls is in gpui-kit.d.ts", { skip: !dts && "no gpui-kit.d.ts on this machine" }, () => {
  const missing = [...called].filter((name) => !new RegExp(`\\b${name}\\??\\s*(\\(|<|:\\s*\\()`).test(dts));
  assert.deepEqual(missing, []);
});
