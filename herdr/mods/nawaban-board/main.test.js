// Render smoke test: main.js's view drawn against stand-ins for Herdr's "gpui-kit", "gpui-base" and
// "herdr" modules, which record every element method called. Each name must exist in Herdr's API,
// gpui-kit.d.ts, which herdr-app writes into ~/.config/herdr-app and into a mod folder it loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { leadersView, pendingView, okrView } from "./logic.js";

const called = new Set();
let onSize = null;
let lastId = null;
const clicks = new Map(); // an element's id -> its click handler
const texts = []; // every string drawn as a child
// An element: any method records its name and returns the element. `when` and `hover` run their
// builder, as gpui does, so the branches they add are drawn too.
const el = new Proxy({}, {
  get: (_, name) => typeof name === "symbol" ? undefined : (...args) => {
    called.add(name);
    if (name === "when") return args[0] ? args[1](el) : el;
    if (name === "hover") args[0](el);
    if (name === "on_size_change") onSize = args[0];
    if (name === "id") lastId = args[0];
    if (name === "on_click") clicks.set(lastId, args[0]);
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
// Herdr's tree: t6 started two workers with `hc run`; they have no pane, so no AgentInfo.
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

// The same space on a GitHub-tracked project: t6's children are issues by their gh-<n> names.
const issue = (n, x) => open(`#${n}`, { title: `issue ${n}`, ...x });
const ghBoard = { tracker: "github", columns: [
  { key: "in_progress", tasks: [issue(239, { status: "in_progress", session: "gh-239", claimed_at: now - 600, progress: note("第 2 步") })] },
  { key: "open", tasks: [issue(256, { active_at: now - 3600 })] },
  { key: "done", tasks: [{ id: "#260", title: "issue 260", status: "done", parent: null, session: null, leader: null, terminal: null,
    claimed_at: null, created_at: 0, active_at: now - 600, done_at: now - 600 }] }] };
let execImpl = async () => ({ code: 1 });
let runImpl = async () => {};
const here = { spaces: () => [{ id: "here", active: true, name: "nawaban", folder: "/x" }], focused: () => ({ space: "here", cwd: "/x" }) };
let where = here;

const stubs = {
  "gpui-kit": { View: class {}, div: make("div"), svg: make("svg"), PathBuilder: el },
  "gpui-base": { v_flex: make("v_flex"), h_flex: make("h_flex"), Popover: el, HoverCard: el, Collapsible: el, Accordion: el,
    AccordionItem: el, AccordionHeader: el, AccordionTrigger: el, AccordionPanel: el, Progress: el, ProgressTrack: el, ProgressIndicator: el },
  herdr: { spaces: () => where.spaces(), focused: () => where.focused(),
    agents: () => agents, terminals: () => terminals, theme: () => new Proxy({}, { get: () => "#808080" }), home: () => "/h",
    run: (...a) => runImpl(...a), exec: (...a) => execImpl(...a), nextCommand: () => new Promise(() => {}), watchFolder: () => new Promise(() => {}), props: () => null, closeOverlay: () => null },
};
globalThis.__nawabanStubs = stubs;
globalThis.window = { paint_path: make("paint_path") }; // Herdr's global window
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
  // with pending decisions: the windows folded and not; a click on one opens its issue
  const pending = { brief: "待决：发吗？", at: now - 3600, progress: [] };
  const withPending = { ...ghBoard, columns: ghBoard.columns.map((c) => c.key !== "open" ? c : { ...c, tasks: c.tasks.map((x) => ({ ...x, url: "https://gh/256", pending })) }) };
  assert.deepEqual(pendingView(withPending).map((p) => p.id), ["#256"]);
  const opened = [];
  execImpl = async (cmd, args) => { opened.push([cmd, ...args]); return { code: 0 }; };
  try {
    for (const unfold of [false, true]) {
      for (const board of [ghBoard, withPending]) {
        const view = new NawabanBoard();
        view.init({}, cx);
        Object.assign(view, { lang: "zh", board, windowsOpen: unfold });
        if (unfold) view.unfolded.add("t6");
        view.render(cx);
      }
    }
    clicks.get("nawaban-pending-#256")();
    assert.deepEqual(opened, [["open", "https://gh/256"]]);
  } finally {
    execImpl = async () => ({ code: 1 });
  }
  assert.ok(called.has("content") && called.has("open"));
});

test("on a GitHub board a blocked worker is a 等你 card above the pending decisions, out of the fold and its count; none blocked, the panel as before", () => {
  const cx = { spawn() {}, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  const pending = { brief: "待决：发吗？", at: now - 3600, progress: [] };
  const withPending = { ...ghBoard, columns: ghBoard.columns.map((c) => c.key !== "open" ? c : { ...c, tasks: c.tasks.map((x) => ({ ...x, url: "https://gh/256", pending })) }) };
  const focused = [];
  runImpl = async (cmd, args) => { focused.push([cmd, args]); };
  const draw = () => {
    clicks.clear();
    texts.length = 0;
    const view = new NawabanBoard();
    view.init({}, cx);
    Object.assign(view, { lang: "zh", board: withPending }); // the groups folded
    view.render(cx);
    return { view, v: leadersView({ agents, terminals, space: "here", board: withPending, now, lang: "zh" }) };
  };
  const saved = terminals;
  try {
    // t9 (gh-260, no pane) is blocked
    let { view, v } = draw();
    assert.deepEqual(v.waiting.map((c) => c.focus), ["t9"]);
    assert.deepEqual(view.keys, ["card:0"]); // the card is in the arrow keys while the groups are folded
    assert.ok(texts.indexOf("1 个窗口在等你") >= 0 && texts.indexOf("1 个窗口在等你") < texts.indexOf("待决 1"), texts.join("|"));
    assert.ok(texts.includes(`窗口分组 ${v.groups.length + (v.idle.count > 0 ? 1 : 0)}`)); // the card is not counted in the fold
    clicks.get("nawaban-card-0")({}, cx);
    assert.deepEqual(focused, [["agent.focus", { terminal: "t9" }]]);
    // nothing blocked: no card, no keys while folded, the fold counts what it did before
    terminals = saved.map((k) => (k.status === "blocked" ? { ...k, status: "done" } : k));
    ({ view, v } = draw());
    assert.deepEqual([v.waiting, view.keys, clicks.has("nawaban-card-0")], [[], [], false]);
    assert.ok(!texts.some((s) => s.includes("个窗口在等你")));
    assert.ok(texts.includes(`窗口分组 ${v.groups.length + (v.idle.count > 0 ? 1 : 0)}`));
  } finally {
    terminals = saved;
    runImpl = async () => {};
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

const okrFixture = JSON.parse(readFileSync(new URL("./okr.fixture.json", import.meta.url), "utf8"));

test("the OKR section draws its cards, sparks, Objectives folded and open, and KR rows, down to 300 px", () => {
  const cx = { spawn() {}, notify() {}, timer: { every() {} }, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  assert.ok(okrView(okrFixture, "zh").attention.some((a) => a.spark));
  for (const lang of ["zh", "en"]) {
    for (const width of [420, 300]) {
      const view = new NawabanBoard();
      view.init({}, cx);
      Object.assign(view, { lang, board, okr: okrFixture });
      view.okrOpen.add("听得懂需求");
      view.render(cx);
      onSize({ width }, cx);
      view.render(cx);
    }
  }
  for (const m of ["paint_path", "dash_array", "line_to", "header", "panel", "on_change", "value", "trigger", "truncate"]) assert.ok(called.has(m), m);
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
    view.okr = okrFixture; // a repository that had one
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
    if (args[2] === "okr") return new Promise(() => {}); // never answers
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
    assert.deepEqual(reads.filter(([v]) => v === "okr"), [["okr", 5000]]); // in flight: not asked again; with its own timeout
    assert.equal(view.okr, null);
  } finally {
    execImpl = async () => ({ code: 1 });
  }
});

test("A, then B, then back to A: a late answer never overwrites a newer one, nor another space's", async () => {
  const asked = []; // [folder, resolve] per json okr
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
    view.init({}, cx); // A1 in flight
    await settle();
    where = at("B");
    view.refresh(cx); // B1
    await settle();
    where = at("A");
    view.refresh(cx); // A1 still in flight: not asked again
    await settle();
    assert.deepEqual(asked.map(([cwd]) => cwd), ["/A", "/B"]);
    assert.equal(view.okr, null); // B's answer is not A's, A's not come yet
    asked[1][1](okrOf("/b", "B1")); // B answers late, while A is shown
    await settle();
    assert.equal(view.okr, null);
    asked[0][1](okrOf("/a", "A1"));
    await settle();
    assert.equal(view.okr.def_commit, "A1");
    view.refresh(cx); // A2
    await settle();
    asked[2][1](okrOf("/a", "A2"));
    await settle();
    assert.equal(view.okr.def_commit, "A2");
    view.refresh(cx); // A3
    await settle();
    view.okrFlight.set("|/A", view.okrGen + 1); // a newer read of A took over before A3 answered
    asked[3][1](okrOf("/a", "A3-late"));
    await settle();
    assert.equal(view.okr.def_commit, "A2");
  } finally {
    where = here;
    execImpl = async () => ({ code: 1 });
  }
});

test("every element method the panel calls is in gpui-kit.d.ts", { skip: !dts && "no gpui-kit.d.ts on this machine" }, () => {
  const missing = [...called].filter((name) => !new RegExp(`\\b${name}\\??\\s*(\\(|<|:\\s*\\()`).test(dts));
  assert.deepEqual(missing, []);
});
