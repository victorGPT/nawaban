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
export function windowsView({ agents, space, board, now, lang, projects, project, terminals = [] }) {
  const nameOf = namer(terminals);
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
    return { name: nameOf(a), ...(state === "waiting" && { question: asking?.waiting ?? words.confirm }),
      doing: blocked ? a.title : task?.title ?? a.title, state, label: words[state], duration: since == null ? null : span(now - since, lang, !!asking),
      focus: a.address, ...(task?.url && { url: task.url }), seq: a.seq, since };
  });
  // A waiting task in no window of this space still asks. Its terminal in another space: named by
  // that window, which its button focuses. Unknown to Herdr: named by its ID, with no button.
  const strays = open.filter((t) => t.waiting != null && !here.some((a) => a.address === t.terminal))
    .map((t) => {
      const away = agents.find((a) => a.address === t.terminal) ?? terminals.find((k) => k.state === "live" && k.address === t.terminal);
      return { name: away ? nameOf(away) : t.id, question: t.waiting, doing: t.title, state: "waiting",
        label: words.waiting, duration: span(now - t.active_at, lang, true), focus: away?.address ?? null, url: t.url ?? null, seq: 0, since: t.active_at };
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

// What a window is called (agents()' AgentInfo): its terminal's Herdr name (`terminals()`, as
// `hc run --name gh-239` gives it), else its tab's name, else its terminal title; never a tab's bare
// index ("4"), which is what Herdr calls a tab nobody named. ponytail: a tab someone named "4"
// reads as unnamed; pass spaces()' TabInfo.named in if that matters.
const namer = (terminals) => {
  const names = new Map(terminals.map((k) => [k.address, k.name]));
  return (a) => names.get(a.address) || (/^\d+$/.test(a.tab_name) ? "" : a.tab_name) || a.title;
};

// The line view (DESIGN.md): windowsView's waiting cards, idle row and other projects' count, and
// in place of its rows one group per leader (GLOSSARY: Leader), as Herdr's terminal tree shows it.
// `terminals` is Herdr's terminals(): every core terminal with its `name`, `parent` and `status`.
export function leadersView(args) {
  const github = args.board?.tracker === "github";
  // The terminals the issues' claims name (`认领：… hc t5n`), before a gh-<n> name fills in the rest.
  const claimedAt = new Map(github ? args.board.columns.flatMap((c) => c.tasks ?? []).filter((t) => t.terminal)
    .sort((x, y) => (y.status === "done") - (x.status === "done")).map((t) => [t.terminal, t.id]) : []); // an open one over a closed one
  if (github) args = { ...args, board: matchIssues(args.board, args.terminals ?? []) };
  // On a GitHub board a pending decision takes needs-info's place (GLOSSARY: Pending decision), so no
  // question makes a card there; a window Herdr says is blocked still does (GLOSSARY: Waiting on you).
  const { waiting: asking, otherWaiting } = windowsView(!github ? args : { ...args, board: { ...args.board,
    columns: args.board.columns.map((c) => ({ ...c, tasks: (c.tasks ?? []).map((t) => ({ ...t, waiting: null })) })) } });
  const terminals = args.terminals ?? [], nameOf = namer(terminals);
  const tasks = (args.board?.columns ?? []).flatMap((c) => c.tasks ?? []);
  const agentAt = (terminal) => args.agents.find((a) => a.address === terminal);
  // A window: its agent, else its live terminal (a worker started with `hc run` has no pane, so no agent).
  const live = terminals.filter((k) => k.state === "live");
  const windowAt = (terminal) => agentAt(terminal) ?? live.find((k) => k.address === terminal);
  // Herdr's tree: an agent of the space with live child terminals leads its whole subtree (its
  // workers' workers too, with a pane or not), in start order, unless it is itself in another
  // agent's subtree: the topmost one leads. `seen` stops a cycle in `parent`.
  // ponytail: start order is address order (Herdr numbers terminals as they start, in base 36:
  // t9, t10, t1b); `hc ls` gives no start time.
  const order = (k) => parseInt(k.address.split("/").pop().slice(1), 36);
  const below = (addr, seen) => live.filter((k) => k.parent === addr && !seen.has(k.address))
    .flatMap((k) => (seen.add(k.address), [k, ...below(k.address, seen)]));
  const trees = args.agents.filter((a) => a.space === args.space).map((a) => [a.address, below(a.address, new Set([a.address]))]);
  const inner = new Set(trees.flatMap(([, d]) => d.map((k) => k.address)));
  const kids = new Map(trees.filter(([a, d]) => d.length && !inner.has(a)).map(([a, d]) => [a, d.sort((x, y) => order(x) - order(y))]));
  const parentOf = new Map([...kids].flatMap(([p, c]) => c.map((k) => [k.address, p]))); // a terminal -> its leader
  // A task's state, as an item or a spec's segment: done, current (held, its terminal working or
  // unknown), stopped (held, its terminal idle or gone), todo.
  const stateOf = (t) => {
    if (t.status === "done") return "done";
    if (!t.session) return "todo";
    const a = t.terminal && windowAt(t.terminal);
    return t.terminal && (!a || a.status === "idle") ? "stopped" : "current";
  };
  // Whether a task puts an item under its leader: held, or dispatched and not started (a leader but
  // never claimed), or done in the last 24 h. A released task is in no group: nobody is on it.
  const inGroup = (t) => t.status === "done" ? t.done_at >= args.now - DAY : t.session != null || t.claimed_at == null;
  // A ticket stands in its spec's place: the item is the topmost task on the board above it.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rootOf = (t) => { while (byId.has(t.parent)) t = byId.get(t.parent); return t; };
  // A task's group: the Herdr leader of the window holding it (that window's parent, or the window
  // itself); else its board leader (a board with no leader field, an older CLI: its holder), which
  // is that leader's Herdr group when the leader's session holds a task in a leader terminal.
  const groupOf = (t) => {
    if (parentOf.has(t.terminal)) return parentOf.get(t.terminal);
    if (kids.has(t.terminal)) return t.terminal;
    if (github) return null; // a claim's text names no leader: an issue in no Herdr window is in no group
    const leader = sessionKey(t.leader ?? t.session);
    const home = tasks.find((x) => leader != null && sessionKey(x.session) === leader && kids.has(x.terminal))?.terminal;
    return home ?? leader;
  };
  const groups = new Map([...kids.keys()].map((p) => [p, new Set()])); // leader -> the items' tasks, deduplicated
  const atKid = new Map(); // a child terminal -> the open task it holds (a ticket, not its spec)
  for (const t of tasks) {
    const leader = groupOf(t);
    if (leader == null || !inGroup(t) || (github && parentOf.has(t.terminal))) continue; // a child shows its issue by its name
    if (!groups.has(leader)) groups.set(leader, new Set());
    groups.get(leader).add(rootOf(t));
    if (t.status !== "done" && t.session != null && parentOf.has(t.terminal)) atKid.set(t.terminal, t);
  }
  const named = (leader) => {
    const a = agentAt(kids.has(leader) ? leader : tasks.find((x) => sessionKey(x.session) === leader && x.terminal)?.terminal);
    return a ? nameOf(a) : leader.slice(0, 8);
  };
  // An item: a task, or a spec with its tickets, whose held ticket (a stopped one first) speaks for
  // it; with none held, the spec speaks for itself.
  const itemOf = (r, leader) => {
    const tickets = specOrder(tasks.filter((t) => t !== r && rootOf(t) === r));
    const states = tickets.map(stateOf), done = states.filter((s) => s === "done").length;
    const lead = tickets[states.indexOf("stopped")] ?? tickets[states.indexOf("current")] ?? r;
    const state = r.status === "done" || (tickets.length && done === tickets.length) ? "done" : stateOf(lead);
    const held = state === "current" || state === "stopped";
    // Dispatched: held by another session or window, or a task not started (only a dispatch note gives an unclaimed task a leader).
    const self = sessionKey(lead.session) === leader || lead.terminal === leader;
    const who = held ? (self ? "self" : "worker") : state === "todo" && !tickets.length ? "worker" : null;
    const all = [r, ...tickets], claims = all.map((t) => t.claimed_at).filter((c) => c != null);
    // Since when, in seconds: done, when it was done; current, its first claim; stopped, its latest event.
    const at = state === "done" ? r.done_at ?? Math.max(...tickets.map((t) => t.done_at ?? 0))
      : state === "current" ? lead.claimed_at : state === "stopped" ? lead.active_at : null;
    return { id: r.id, title: r.title, state, at, gone: state === "stopped" && !windowAt(lead.terminal), who,
      note: held ? lead.progress?.body ?? null : null, focus: held && windowAt(lead.terminal) ? lead.terminal : null,
      spec: tickets.length ? { tickets: tickets.map((t) => t.id), segments: states, done, total: tickets.length } : null,
      claimed: claims.length ? Math.min(...claims) : Infinity, created_at: r.created_at,
      decisions: all.map((t) => t.decision).filter(Boolean), // the board gives open tasks only a decision
      active: Math.max(...all.map((t) => t.active_at)) };
  };
  // A child terminal, keyed and focused by its terminal: the task it holds (a ticket: the ticket,
  // so two children on one spec stay two items, and the spec is not listed again), under the
  // child's Herdr name; holding none, what Herdr says
  // of it: its name, its title (when it has a pane, so an agent) as the note. Its state: working is
  // current, blocked (or error) waiting on you, anything else done, idle too: Herdr turns done into
  // idle once you look, and a worker with no task has nothing to stop on.
  const kidName = (k) => k.name || k.program?.name || k.address;
  const kidItem = (k, leader) => {
    const key = `${leader}/${k.address}`, a = agentAt(k.address), status = a?.status ?? k.status;
    const n = github && /^gh-(\d+)/.exec(k.name ?? "");
    const issue = github && (byId.get(claimedAt.get(k.address)) ?? (n && byId.get(`#${n[1]}`)));
    if (issue) return { ...issueItem(issue, status, args.now), key, name: kidName(k), focus: k.address };
    if (atKid.has(k.address)) return { ...itemOf(atKid.get(k.address), leader), key, name: kidName(k), focus: k.address };
    return { key, id: k.address, title: kidName(k), name: kidName(k), state: status === "working" ? "current" : status === "blocked" || status === "error" ? "waiting" : "done",
      at: null, gone: false, who: "worker", note: a?.title || null, focus: k.address, spec: null, decisions: [], active: 0 };
  };
  const out = [...groups].map(([leader, roots]) => {
    const tree = kids.get(leader) ?? [], taken = new Set(tree.filter((k) => atKid.has(k.address)).map((k) => rootOf(atKid.get(k.address))));
    // The children first, as they started; then the rest by first claim (arrival), unclaimed ones by creation.
    const all = [...tree.map((k) => kidItem(k, leader)), ...[...roots].filter((r) => !taken.has(r)).map((r) => itemOf(r, leader))
      .sort((x, y) => x.claimed - y.claimed || x.created_at - y.created_at)];
    // A closed issue folds into the group's 已关 row, numbered after the rest.
    const numbered = [...all.filter((x) => !x.closed), ...all.filter((x) => x.closed)]
      .map(({ claimed, created_at, decisions, active, ...x }, i) => ({ key: `${leader}/${x.id}`, number: i + 1, ...x }));
    const items = numbered.filter((x) => !x.closed), closed = numbered.filter((x) => x.closed);
    const dispatched = numbered.filter((i) => i.who === "worker").length;
    const last = all.flatMap((x) => x.decisions).sort((x, y) => y.at - x.at)[0];
    return { leader, name: named(leader), self: numbered.length - dispatched, dispatched,
      decision: last ? { at: last.at, verdict: last.verdict.split("\n")[0] } : null, items, closed,
      stopped: items.some((i) => i.state === "stopped" || i.state === "waiting"), active: Math.max(...all.map((x) => x.active)) };
  }).sort((x, y) => y.stopped - x.stopped || y.active - x.active).map(({ stopped, active, ...g }) => g);
  // On a GitHub board a worker `hc run` started has no pane, so no agent and no card from windowsView:
  // blocked, it is a card too, named and titled as its item. Only blocked, as windowsView's cards.
  const words = WINDOW_WORDS[args.lang];
  const items = out.flatMap((g) => [...g.items, ...g.closed]);
  const unpaned = !github ? [] : live.filter((k) => parentOf.has(k.address) && !agentAt(k.address) && k.status === "blocked")
    .map((k) => items.find((x) => x.focus === k.address)).filter(Boolean)
    .map((x) => ({ name: x.name, question: words.confirm, doing: x.title, state: "waiting", label: words.waiting, duration: null,
      focus: x.focus, ...(x.url && { url: x.url }) }));
  const waiting = [...asking, ...unpaned];
  // Every window of the space that is neither a card, a leader or its child, nor the terminal of an
  // open task, named with what Herdr says it is doing unless idle: a window working without a task still shows.
  const free = args.agents.filter((a) => a.space === args.space && !waiting.some((c) => c.focus === a.address)
    && !kids.has(a.address) && !parentOf.has(a.address) && !tasks.some((t) => t.status !== "done" && t.terminal === a.address))
    .map((a) => (a.status === "working" || a.status === "done" ? words.withState(nameOf(a), words[a.status]) : nameOf(a)));
  const idle = { count: free.length, names: free };
  // Selection keys, unique where terminals are not: a card and an item, or two items, can share one.
  const cards = waiting.map((c, i) => ({ key: `card:${i}`, ...c }));
  const keys = [...cards, ...out.flatMap((g) => g.items)].filter((x) => x.focus != null || x.url).map((x) => x.key);
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

// A GitHub board's top (GLOSSARY: Pending decision): the open issues holding a pending decision,
// oldest first, a tie by issue number, as `nawaban brief` lists them.
export const pendingView = (board) => (board?.columns ?? []).filter((c) => c.key !== "done").flatMap((c) => c.tasks ?? [])
  .filter((t) => t.pending).sort((x, y) => x.pending.at - y.pending.at || x.id.slice(1) - y.id.slice(1))
  .map((t) => ({ id: t.id, title: t.title, url: t.url ?? null }));

// A GitHub board's issues, each in its window: the live terminal its claim names (`hc t5n`), else the
// live window named for it: `gh-275`, `gh-238r` (`hc run --name`) is #275, #238.
const matchIssues = (board, terminals) => {
  const live = terminals.filter((k) => k.state === "live"), alive = new Set(live.map((k) => k.address));
  const at = new Map(live.flatMap((k) => {
    const m = /^gh-(\d+)/.exec(k.name ?? "");
    return m ? [[`#${m[1]}`, k.address]] : [];
  }));
  return { ...board, columns: board.columns.map((c) => ({ ...c, tasks: (c.tasks ?? []).map((t) => ({ ...t, terminal: alive.has(t.terminal) ? t.terminal : at.get(t.id) ?? t.terminal })) })) };
};

// An issue as its window's item, in GitHub's terms: closed is done (and folds); open, waiting on you
// (needs-info, or Herdr says blocked), current while its window works, else pushing while the issue
// moved (any comment or edit) in the last 24 hours, else stopped since then.
const issueItem = (t, status, now) => {
  const state = t.status === "done" ? "done" : t.waiting != null || status === "blocked" || status === "error" ? "waiting"
    : status === "working" ? "current" : now - t.active_at < DAY ? "pushing" : "stopped";
  return { id: t.id, title: t.title, state, at: state === "done" ? t.done_at : state === "current" ? t.claimed_at : state === "stopped" ? t.active_at : null,
    gone: false, who: "worker", note: t.progress?.body ?? null, spec: null, decisions: t.decision ? [t.decision] : [], url: t.url ?? null,
    active: t.active_at, closed: state === "done" };
};

// A session as a leader's key: agent-center authors its notes `ac:<session>`, the same session.
const sessionKey = (s) => s?.replace(/^[a-z]+:(?=[0-9a-f]{8})/, "") ?? null;

// A duration in seconds: "20m", "3h", "2d" in the table; on a card, in Chinese, "20 分钟", "1 小时".
const span = (s, lang, card) => {
  if (s < 60) return lang === "zh" ? "刚刚" : "now";
  const [n, zh, en] = s < 3600 ? [s / 60, "分钟", "m"] : s < 86400 ? [s / 3600, "小时", "h"] : [s / 86400, "天", "d"];
  return lang === "zh" && card ? `${Math.floor(n)} ${zh}` : `${Math.floor(n)}${en}`;
};

// An item's state on its right (leadersView's `at` is seconds): "完成 09:10", "完成 昨天 18:40",
// "在干 40 分钟", "停了 2 小时", "还没动". Local time, from Date's getters.
export function itemLabel({ state, at }, now, lang) {
  const w = WINDOW_WORDS[lang], label = w[ITEM_STATE[state]];
  if (at == null) return label;
  if (state !== "done") return `${label} ${span(now - at, lang, true)}`;
  const d = new Date(at * 1000), day = (x) => new Date(x * 1000).setHours(0, 0, 0, 0);
  const ago = Math.round((day(now) - day(at)) / 86400000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${label} ${ago === 0 ? time : ago === 1 ? `${w.yesterday} ${time}` : `${decisionDate(at)} ${time}`}`;
}

const ITEM_STATE = { done: "done", current: "working", pushing: "pushing", stopped: "stopped", todo: "todo", waiting: "waiting" };
const pad = (n) => String(n).padStart(2, "0");

// A decision's day, "11-05", local time.
export const decisionDate = (at) => { const d = new Date(at * 1000); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// The panel's words; WINDOW_WORDS[lang][state] is a state's label.
export const WINDOW_WORDS = {
  zh: { waiting: "等你", pushing: "在推", closed: (n) => `已关 ${n} 个`, stopped: "停了", done: "完成", working: "在干", idle: "空闲", todo: "还没动", yesterday: "昨天", confirm: "在等你确认",
    windows: (n) => `${n} 个窗口`, elsewhere: (n) => (n ? `其他项目 ${n} 个等你` : "其他项目没有等你的"),
    headline: (n) => `${n} 个窗口在等你`, waited: (d) => `等了 ${d}`, go: "去窗口 →", issue: "去 GitHub 看 →",
    counts: (own, sent) => `自己 ${own} · 派出 ${sent}`, decided: "定", who: { self: "自己", worker: "worker" },
    gone: "窗口已关，任务还拿着没交还",
    withState: (name, state) => `${name}（${state}）`, idleRow: (n, names) => `没认领 ${n} · ${names.join("、")}`,
    none: "这个 space 没有 agent 窗口", loading: "读取中…", error: "读不到看板", language: "语言",
    pending: (n) => `待决 ${n}`, windowsFold: (n) => `窗口分组 ${n}` },
  en: { waiting: "Waiting", pushing: "Moving", closed: (n) => `${n} closed`, stopped: "Stopped", done: "Done", working: "Working", idle: "Idle", todo: "Not started", yesterday: "yesterday", confirm: "Waiting for you to confirm",
    windows: (n) => `${n} window${n === 1 ? "" : "s"}`, elsewhere: (n) => (n ? `${n} waiting elsewhere` : "nothing waiting elsewhere"),
    headline: (n) => `${n} window${n === 1 ? "" : "s"} waiting on you`, waited: (d) => `waiting ${d}`, go: "Go to window →", issue: "Open on GitHub →",
    counts: (own, sent) => `own ${own} · sent ${sent}`, decided: "decided", who: { self: "self", worker: "worker" },
    gone: "Window closed, task still held",
    withState: (name, state) => `${name} (${state.toLowerCase()})`, idleRow: (n, names) => `No task ${n} · ${names.join(", ")}`,
    none: "No agent windows in this space", loading: "Loading…", error: "Can't read the board", language: "Language",
    pending: (n) => `Pending ${n}`, windowsFold: (n) => `Window groups ${n}` },
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

// ── OKR (spec NAWABAN-OKRP): `nawaban json okr` as the panel draws it ──

// Attention first by how hard the guardrail is: five missed rounds, two rounds no better, a KR
// waiting on the decision-maker, an Objective ready to accept.
const OKR_KINDS = ["five", "stuck", "wait", "accept"];
const OKR_STATES = ["met", "missed", "stale", "untested"];
const OPS = { ">=": "≥", "<=": "≤", ">": ">", "<": "<", "==": "=" };
const num = (v) => String(Math.round(v * 10) / 10);

// "<= 20" with "%": the comparison, the goal, and "≤ 20%" to show; null when it does not parse.
const parseTarget = (target, unit = "") => {
  const m = /^\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(target ?? "");
  return m ? { op: m[1], goal: Number(m[2]), text: `${OPS[m[1]]} ${m[2]}${unit}` } : null;
};

// The last readings as a small line: x and y as percentages of the drawn box (higher value, higher
// up), with the goal's line on the same scale. Points are spread evenly, oldest on the left.
export function okrSpark(history, goal) {
  const vs = (history ?? []).map((h) => h.value);
  if (!vs.length) return null;
  const all = goal == null ? vs : [...vs, goal], lo = Math.min(...all), hi = Math.max(...all);
  const y = (v) => (hi === lo ? 50 : 10 + ((hi - v) / (hi - lo)) * 80);
  const x = (i) => (vs.length === 1 ? 50 : 4 + (i / (vs.length - 1)) * 92);
  return { points: vs.map((v, i) => [x(i), y(v)]), goal: goal == null ? null : y(goal), labels: vs.map(num) };
}

// A KR's row: its state, the value against the target, and a bar from 0 with the goal's tick on it
// (a % unit is out of 100; any other, out of a quarter past the larger of value and goal).
const krRow = (k, w) => {
  const t = parseTarget(k.target, k.unit ?? ""), has = k.value != null && k.status !== "untested";
  const scale = k.unit === "%" ? 100 : Math.max(Math.abs(k.value ?? 0), Math.abs(t?.goal ?? 0)) * 1.25 || 1;
  const pct = (v) => Math.min(100, Math.max(0, (v / scale) * 100));
  return { name: k.name, status: OKR_STATES.includes(k.status) ? k.status : "untested",
    value: has ? `${num(k.value)}${k.unit ?? ""}` : w.status.untested, target: t?.text ?? k.target ?? "",
    goal: t?.goal ?? null, fill: has ? pct(k.value) : null, tick: t ? pct(t.goal) : null,
    as_of: k.as_of ?? null, source: k.source ?? null, trend: w.trend[k.trend] ?? w.trend.null,
    missed_rounds: k.missed_rounds ?? 0, wait: k.wait ?? null, history: k.history ?? [] };
};

// The OKR section, or null to leave it out: no okr.toml, a CLI without `json okr`, or a reading
// that is not the contract. Attention: one card per KR (the harder kind wins), by kind, then in the
// order okr.toml lists them; stuck and five carry the last readings. Each Objective: met/total, one
// segment per KR (met, missed, stale, untested), its KR rows in okr.toml's order.
export function okrView(okr, lang) {
  if (!okr || !Array.isArray(okr.objectives) || !okr.objectives.length) return null;
  const w = OKR_WORDS[lang] ?? OKR_WORDS.en;
  const objectives = okr.objectives.map((o) => {
    const krs = (o.krs ?? []).map((k) => krRow(k, w));
    const counts = Object.fromEntries(OKR_STATES.map((s) => [s, krs.filter((k) => k.status === s).length]));
    return { name: o.name, met: o.met ?? counts.met, total: o.total ?? krs.length, counts,
      segments: OKR_STATES.flatMap((s) => Array(counts[s]).fill(s)), krs, attention: false };
  });
  const rank = (a) => {
    const oi = objectives.findIndex((o) => o.name === a.objective), o = objectives[oi];
    return [OKR_KINDS.indexOf(a.kind), oi, o ? o.krs.findIndex((k) => k.name === a.kr) : -1];
  };
  const seen = new Set();
  const attention = (okr.attention ?? []).filter((a) => OKR_KINDS.includes(a.kind))
    .map((a) => [rank(a), a]).sort(([x], [y]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
    .filter(([, a]) => { const k = `${a.objective}\0${a.kr ?? ""}`; return !seen.has(k) && seen.add(k); })
    .map(([, a], i) => {
      const o = objectives.find((x) => x.name === a.objective), kr = o?.krs.find((k) => k.name === a.kr);
      if (o) o.attention = true;
      const spark = (a.kind === "stuck" || a.kind === "five") && kr ? okrSpark(kr.history, kr.goal) : null;
      return { key: `okr:${i}`, kind: a.kind, label: w.kind[a.kind], title: a.kr || a.objective,
        objective: a.kr ? a.objective : null, text: a.text ?? "", spark, target: kr ? `${w.target} ${kr.target}` : null };
    });
  const at = okr.last_measured_at;
  return { met: okr.met, total: okr.total, measured: at ? `${at.slice(5, 10)} ${at.slice(11, 16)}` : null, attention, objectives };
}

export const OKR_WORDS = {
  zh: { headline: (n) => `${n} 件要你盯`, summary: (met, total, at) => `OKR ${met}/${total} 达标${at ? ` · ${at} 量` : ""}`,
    kind: { five: "5 轮未达标", stuck: "两轮没变好", wait: "等你做", accept: "等你验收" },
    status: { met: "达标", missed: "未达标", stale: "过期", untested: "未测" },
    trend: { closer: "在变好", away: "在变差", flat: "没动", null: "首次读数" },
    target: "目标", value: "现值", asOf: "截至", source: "来源", trendLabel: "走向", rounds: (n) => `连续 ${n} 轮未达标`, wait: "要你做" },
  en: { headline: (n) => `${n} thing${n === 1 ? "" : "s"} for you`, summary: (met, total, at) => `OKR ${met}/${total} met${at ? ` · measured ${at}` : ""}`,
    kind: { five: "Missed 5 rounds", stuck: "No better in 2 rounds", wait: "Needs you", accept: "Ready to accept" },
    status: { met: "Met", missed: "Missed", stale: "Stale", untested: "Untested" },
    trend: { closer: "Getting closer", away: "Moving away", flat: "Flat", null: "First reading" },
    target: "Target", value: "Value", asOf: "As of", source: "Source", trendLabel: "Trend", rounds: (n) => `missed ${n} rounds in a row`, wait: "Needs you to" },
};
