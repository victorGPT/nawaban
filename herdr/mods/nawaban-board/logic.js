// Pure logic of the nawaban-board mod: no "herdr" or "gpui-kit" imports, so `node --test` runs it.

// The project a folder belongs to, as the CLI names it (its repository's main checkout, also from
// a worktree), from `git rev-parse --path-format=absolute --git-common-dir` run there. null (show
// every project) when the folder is in no repository or the board has no such project.
export function projectFor(gitCommonDir, projects) {
  const parts = gitCommonDir.trim().split("/").filter(Boolean);
  const name = parts.length >= 2 ? parts[parts.length - 2] : null;
  return (projects?.projects ?? []).some((p) => p.name === name) ? name : null;
}

// "zh" or "en": the person's saved choice, else the system's first preferred language, read from
// `defaults read -g AppleLanguages` on macOS or $LANG elsewhere.
export function resolveLang(saved, system) {
  if (saved === "zh" || saved === "en") return saved;
  return /^zh/i.test(String(system ?? "").replace(/[\s("]/g, "")) ? "zh" : "en";
}

// Whether paths `watchFolder` reported on the board's folder mean the board changed: the board file,
// its write-ahead log, or the folder itself (the watcher gave up listing). Not `-shm`: every reader,
// this panel's own refresh included, writes it, so counting it would refresh in a loop.
export const boardChanged = (paths, db) =>
  paths.some((p) => p === db || p === `${db}-wal` || p === db.slice(0, db.lastIndexOf("/")));

// The focused space's Herdr agents (those of `agents`, every space's, whose `space` is `space`) joined with its project's
// `nawaban json board`, as the panel draws them: a card per window waiting on you, a row per
// window stopped, done or working, and the idle ones counted. A task is in the window whose
// terminal address is its `terminal`. Each window takes the first state that holds: 等你 (it holds
// a task asking a triage question, or Herdr says blocked), 停了 (it holds an open task and Herdr says idle), 完成, 在干,
// 空闲. Durations run from the held task's latest event; Herdr records none of its own.
// `otherWaiting` sums `json projects`' waiting counts of every project but `project`.
export function windowsView({ agents, space, board, now, lang, projects, project }) {
  const open = (board?.columns ?? []).filter((c) => c.key !== "done").flatMap((c) => c.tasks ?? [])
    .sort((x, y) => y.active_at - x.active_at);
  const words = WINDOW_WORDS[lang];
  const here = agents.filter((a) => a.space === space);
  const windows = here.map((a) => {
    const mine = open.filter((t) => t.terminal === a.address);
    const asking = mine.find((t) => t.waiting != null);
    const task = asking ?? mine[0];
    const blocked = !asking && a.status === "blocked";
    const state = asking || blocked ? "waiting" : task && a.status === "idle" ? "stopped"
      : a.status === "done" || a.status === "working" ? a.status : "idle";
    // Herdr records no time for `blocked` (`seq` only orders changes), so that wait has no length.
    const since = blocked ? null : task?.active_at ?? null;
    return { name: a.tab_name || a.title, ...(state === "waiting" && { question: asking?.waiting ?? words.confirm }),
      doing: blocked ? a.title : task?.title ?? a.title, state, label: words[state], duration: since == null ? null : span(now - since, lang, !!asking),
      focus: a.address, seq: a.seq, since };
  });
  // A waiting task in no window of this space still asks. Its terminal in another space: named by
  // that window, which its button focuses. Unknown to Herdr: named by its ID, with no button.
  const strays = open.filter((t) => t.waiting != null && !here.some((a) => a.address === t.terminal))
    .map((t) => {
      const away = agents.find((a) => a.address === t.terminal);
      return { name: away ? away.tab_name || away.title : t.id, question: t.waiting, doing: t.title, state: "waiting",
        label: words.waiting, duration: span(now - t.active_at, lang, true), focus: away?.address ?? null, seq: 0, since: t.active_at };
    });
  const out = ({ seq, since, ...w }) => w;
  // Longest-waiting first; the blocked windows, whose wait has no length, after them.
  const waiting = [...windows, ...strays].filter((w) => w.state === "waiting")
    .sort((x, y) => (x.since ?? Infinity) - (y.since ?? Infinity) || y.seq - x.seq).map(out);
  const rows = ROW_ORDER.flatMap((s) => windows.filter((w) => w.state === s).sort((x, y) => y.seq - x.seq)).map(out);
  const idle = windows.filter((w) => w.state === "idle").map((w) => w.name);
  const otherWaiting = (projects?.projects ?? []).reduce((n, p) => n + (p.name === project ? 0 : p.waiting ?? 0), 0);
  return { waiting, rows, idle: { count: idle.length, names: idle }, otherWaiting };
}

const ROW_ORDER = ["stopped", "done", "working"];

// The line view (DESIGN.md): windowsView's waiting cards, idle row and other projects' count, and
// in place of its rows one group per leader (GLOSSARY: Leader).
export function leadersView(args) {
  const { waiting, idle, otherWaiting } = windowsView(args);
  const tasks = (args.board?.columns ?? []).flatMap((c) => c.tasks ?? []);
  const agentAt = (terminal) => args.agents.find((a) => a.address === terminal);
  // A task's state, as an item or a spec's segment: done, current (held, its terminal working or
  // unknown), stopped (held, its terminal idle or gone), todo.
  const stateOf = (t) => {
    if (t.status === "done") return "done";
    if (!t.session) return "todo";
    const a = t.terminal && agentAt(t.terminal);
    return t.terminal && (!a || a.status === "idle") ? "stopped" : "current";
  };
  // Whether a task puts an item under its leader: held, or dispatched and not started (a leader but
  // never claimed), or done in the last 24 h. A released task is in no group: nobody is on it.
  const inGroup = (t) => t.status === "done" ? t.done_at >= args.now - DAY : t.session != null || t.claimed_at == null;
  // A ticket stands in its spec's place: the item is the topmost task on the board above it.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rootOf = (t) => { while (byId.has(t.parent)) t = byId.get(t.parent); return t; };
  const groups = new Map(); // leader -> the items' tasks, deduplicated
  for (const t of tasks) {
    if (t.leader == null || !inGroup(t)) continue;
    const leader = sessionKey(t.leader);
    if (!groups.has(leader)) groups.set(leader, new Set());
    groups.get(leader).add(rootOf(t));
  }
  const named = (leader) => {
    const a = agentAt(tasks.find((x) => sessionKey(x.session) === leader && x.terminal)?.terminal);
    return a ? a.tab_name || a.title : leader.slice(0, 8);
  };
  // An item: a task, or a spec with its tickets, whose held ticket (a stopped one first) speaks for it.
  const itemOf = (r, leader) => {
    const tickets = specOrder(tasks.filter((t) => t !== r && rootOf(t) === r));
    const states = tickets.map(stateOf), done = states.filter((s) => s === "done").length;
    const lead = tickets.length ? tickets[states.indexOf("stopped")] ?? tickets[states.indexOf("current")] : r;
    const state = r.status === "done" || (tickets.length && done === tickets.length) ? "done" : lead ? stateOf(lead) : "todo";
    const held = state === "current" || state === "stopped";
    // Dispatched: held by another session, or a task not started (only a dispatch note gives an unclaimed task a leader).
    const who = held ? (sessionKey(lead.session) === leader ? "self" : "worker") : state === "todo" && !tickets.length ? "worker" : null;
    const all = [r, ...tickets], claims = all.map((t) => t.claimed_at).filter((c) => c != null);
    // Since when, in seconds: done, when it was done; current, its first claim; stopped, its latest event.
    const at = state === "done" ? r.done_at ?? Math.max(...tickets.map((t) => t.done_at ?? 0))
      : state === "current" ? lead.claimed_at : state === "stopped" ? lead.active_at : null;
    return { id: r.id, title: r.title, state, at, gone: state === "stopped" && !agentAt(lead.terminal), who,
      note: held ? lead.progress?.body ?? null : null, focus: held && agentAt(lead.terminal) ? lead.terminal : null,
      spec: tickets.length ? { tickets: tickets.map((t) => t.id), segments: states, done, total: tickets.length } : null,
      claimed: claims.length ? Math.min(...claims) : Infinity, created_at: r.created_at,
      decisions: all.map((t) => t.decision).filter(Boolean), // the board gives open tasks only a decision
      active: Math.max(...all.map((t) => t.active_at)) };
  };
  const out = [...groups].map(([leader, roots]) => {
    const all = [...roots].map((r) => itemOf(r, leader))
      .sort((x, y) => x.claimed - y.claimed || x.created_at - y.created_at);
    const items = all.map(({ claimed, created_at, decisions, active, ...x }, i) => ({ key: `${leader}/${x.id}`, number: i + 1, ...x }));
    const dispatched = items.filter((i) => i.who === "worker").length;
    const last = all.flatMap((x) => x.decisions).sort((x, y) => y.at - x.at)[0];
    return { leader, name: named(leader), self: items.length - dispatched, dispatched,
      decision: last ? { at: last.at, verdict: last.verdict.split("\n")[0] } : null, items,
      stopped: items.some((i) => i.state === "stopped"), active: Math.max(...all.map((x) => x.active)) };
  }).sort((x, y) => y.stopped - x.stopped || y.active - x.active).map(({ stopped, active, ...g }) => g);
  // Selection keys, unique where terminals are not: a card and an item, or two items, can share one.
  const cards = waiting.map((c, i) => ({ key: `card:${i}`, ...c }));
  const keys = [...cards, ...out.flatMap((g) => g.items)].filter((x) => x.focus != null).map((x) => x.key);
  return { waiting: cards, groups: out, idle, otherWaiting, keys };
}

// A spec's tickets in blocked-by order: the done ones first, by when each was done, then the open
// ones each after its open blockers (the board lists no done blocker); ties keep the board's order.
const specOrder = (tickets) => {
  const out = tickets.filter((t) => t.status === "done").sort((x, y) => x.done_at - y.done_at);
  const open = tickets.filter((t) => t.status !== "done");
  while (open.length) {
    const free = open.findIndex((t) => !(t.blocked_by ?? []).some((b) => open.some((o) => o.id === b)));
    out.push(...open.splice(Math.max(free, 0), 1)); // a cycle: take the first
  }
  return out;
};

const DAY = 86400;

// A session as a leader's key: agent-center authors its notes `ac:<session>`, the same session.
const sessionKey = (s) => s?.replace(/^[a-z]+:(?=[0-9a-f]{8})/, "") ?? null;

// A duration in seconds: "20m", "3h", "2d" in the table; on a card, in Chinese, "20 分钟", "1 小时".
const span = (s, lang, card) => {
  if (s < 60) return lang === "zh" ? "刚刚" : "now";
  const [n, zh, en] = s < 3600 ? [s / 60, "分钟", "m"] : s < 86400 ? [s / 3600, "小时", "h"] : [s / 86400, "天", "d"];
  return lang === "zh" && card ? `${Math.floor(n)} ${zh}` : `${Math.floor(n)}${en}`;
};

// The panel's words; WINDOW_WORDS[lang][state] is a state's label.
export const WINDOW_WORDS = {
  zh: { waiting: "等你", stopped: "停了", done: "完成", working: "在干", idle: "空闲", confirm: "在等你确认",
    windows: (n) => `${n} 个窗口`, elsewhere: (n) => (n ? `其他项目 ${n} 个等你` : "其他项目没有等你的"),
    headline: (n) => `${n} 个窗口在等你`, waited: (d) => `等了 ${d}`, go: "去窗口 →",
    cols: ["窗口", "在干", "状态", "多久"], idleRow: (n, names) => `空闲 ${n} · ${names.join("、")}`,
    none: "这个 space 没有 agent 窗口", loading: "读取中…", error: "读不到看板", language: "语言" },
  en: { waiting: "Waiting", stopped: "Stopped", done: "Done", working: "Working", idle: "Idle", confirm: "Waiting for you to confirm",
    windows: (n) => `${n} window${n === 1 ? "" : "s"}`, elsewhere: (n) => (n ? `${n} waiting elsewhere` : "nothing waiting elsewhere"),
    headline: (n) => `${n} window${n === 1 ? "" : "s"} waiting on you`, waited: (d) => `waiting ${d}`, go: "Go to window →",
    cols: ["Window", "Doing", "State", "For"], idleRow: (n, names) => `Idle ${n} · ${names.join(", ")}`,
    none: "No agent windows in this space", loading: "Loading…", error: "Can't read the board", language: "Language" },
};

// The key the up (-1) or down (+1) arrow selects from `key`, through the cards and rows in the
// order shown; it stops at either end. With nothing selected, or a window no longer shown, down
// starts at the top and up at the bottom.
export function moveSelection(keys, key, delta) {
  if (!keys.length) return null;
  const at = keys.indexOf(key);
  if (at < 0) return keys[delta > 0 ? 0 : keys.length - 1];
  return keys[Math.min(keys.length - 1, Math.max(0, at + delta))];
}

// A key pressed in the panel as one of its commands (the same names `nawaban-board.<command>`
// reaches from keys.json or `herdr-app do`), or null to leave the key alone.
const KEYS = { down: "down", up: "up", enter: "open", escape: "back" };
export const keyCommand = (e) => KEYS[e.keystroke] ?? null;
