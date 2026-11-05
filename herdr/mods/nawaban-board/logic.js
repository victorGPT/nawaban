// Pure logic of the nawaban-board mod: no "herdr" or "gpui-kit" imports, so `node --test` runs it.

const ORDER = ["in_progress", "open", "done"];

// `nawaban json board` columns as the panel lists them: waiting on you (open tasks whose `waiting`
// holds the question of a `triage: needs-info` note; they leave their own group), in progress, open
// (tasks that can start first, blocked ones last and marked), recently done. The board's own
// order, latest activity first, is kept within each.
export function groupTasks(board) {
  const byKey = Object.fromEntries((board?.columns ?? []).map((c) => [c.key, c.tasks ?? []]));
  const waits = (t) => t.waiting != null;
  const groups = ORDER.map((key) => {
    const tasks = (byKey[key] ?? []).filter((t) => !waits(t))
      .map((t) => ({ ...t, blocked: key === "open" && t.open_blockers > 0 }));
    return { key, tasks: [...tasks.filter((t) => !t.blocked), ...tasks.filter((t) => t.blocked)] };
  });
  const waiting = [...(byKey.in_progress ?? []), ...(byKey.open ?? [])].filter(waits)
    .map((t) => ({ ...t, blocked: false })).sort((a, b) => b.active_at - a.active_at);
  return [{ key: "waiting", tasks: waiting }, ...groups];
}

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

// The groups the panel shows: tasks whose ID or title holds the filter text.
export function filterGroups(groups, query) {
  const q = query.trim().toLowerCase();
  const hit = (t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
  return groups.map((g) => ({ ...g, tasks: g.tasks.filter(hit) }));
}

// The list as one run of rows, the way the panel draws it: each group's heading, then every one of
// its tasks. Empty groups take no row.
export function listRows(groups) {
  return groups.filter((g) => g.tasks.length).flatMap((g) => [{ key: `head:${g.key}`, kind: "head", group: g },
    ...g.tasks.map((t) => ({ key: `task:${t.id}`, kind: "task", task: t }))]);
}

// The task row the up (-1) or down (+1) arrow selects from `key`, past the headings; it stops at
// either end. With nothing selected, or a row no longer listed, down starts at the top and up at
// the bottom.
export function moveSelection(rows, key, delta) {
  const tasks = rows.filter((r) => r.kind === "task");
  if (!tasks.length) return null;
  const at = tasks.findIndex((r) => r.key === key);
  if (at < 0) return tasks[delta > 0 ? 0 : tasks.length - 1].key;
  return tasks[Math.min(tasks.length - 1, Math.max(0, at + delta))].key;
}

// The selected row's key while that row is still on screen, else null: Enter never opens a task
// the filter, a refresh or another project has taken out of the list.
export function shownSelection(rows, key) {
  return rows.some((r) => r.key === key) ? key : null;
}

// How long ago an epoch-seconds time was, short.
export function ago(at, now, lang) {
  const s = Math.max(0, now - at);
  if (s < 60) return lang === "zh" ? "刚刚" : "just now";
  const [n, zh, en] = s < 3600 ? [s / 60, "分钟", "m"] : s < 86400 ? [s / 3600, "小时", "h"] : [s / 86400, "天", "d"];
  return lang === "zh" ? `${Math.floor(n)} ${zh}前` : `${Math.floor(n)}${en} ago`;
}

// An ID cut to `max` characters in the middle, so the suffix that tells a spec's tickets apart
// (-01, -02, ...) stays visible: the head, "…", and a tail as long as the head or one longer.
export function shortId(id, max) {
  if (id.length <= max) return id;
  const tail = Math.ceil((max - 1) / 2);
  return `${id.slice(0, max - 1 - tail)}…${id.slice(-tail)}`;
}

// A link event body, `[kind:] value [· note]`; `url` is the value when a browser can open it.
export function linkParts(body) {
  const m = /^([a-z][\w-]*):(?!\/\/)\s*([\s\S]*)$/i.exec(body.trim());
  const rest = m ? m[2] : body.trim();
  const at = rest.indexOf(" · ");
  const value = at < 0 ? rest : rest.slice(0, at);
  return { kind: m ? m[1] : null, value, note: at < 0 ? null : rest.slice(at + 3),
    url: /^https?:\/\/\S+$/.test(value) ? value : null };
}

// Event bodies are written line by line (a decision's Question / Verdict / Rejected); markdown
// would join single newlines, so each one becomes a hard break, and those labels go bold.
export const eventMarkdown = (body) =>
  body.replace(/^(question|verdict|rejected):/gim, "**$1:**").replace(/\n/g, "  \n");

// An open task waits while any task blocking it is neither done nor cancelled.
export const isBlocked = (d) =>
  d.status === "open" && (d.blocked_by ?? []).some((b) => b.status !== "done" && b.status !== "cancelled");

// The events a task's detail lists: notes, decisions and links, in the CLI's newest-first order.
export const detailEvents = (events) => (events ?? []).filter((e) => ["note", "decision", "link"].includes(e.kind));

// Whether paths `watchFolder` reported on the board's folder mean the board changed: the board file,
// its write-ahead log, or the folder itself (the watcher gave up listing). Not `-shm`: every reader,
// this panel's own refresh included, writes it, so counting it would refresh in a loop.
export const boardChanged = (paths, db) =>
  paths.some((p) => p === db || p === `${db}-wal` || p === db.slice(0, db.lastIndexOf("/")));

// Who wrote an event: the user's own decisions read as "you", the rest came from an agent session
// (its id says nothing to a person).
export const authorLabel = (author, lang) => (author === "user" ? WORDS[lang].you : "agent");

export const WORDS = {
  zh: { title: "任务", waiting: "等你", in_progress: "进行中", open: "待认领", done: "最近完成", blocked: "被挡", all: "全部项目",
    filter: "按 ID 或标题过滤", more: (n) => `再显示 ${n} 条`, less: "收起",
    blockedBy: (ids) => `被 ${ids.join("、")} 挡住`, language: "语言",
    empty: "没有任务", none: "没有匹配的任务", loading: "读取中…", error: "读不到看板",
    back: "返回", wholeBody: "显示全文", progress: "当前进度", body: "正文", parent: "上级", you: "你", events: "事件",
    state: { in_progress: "进行中", open: "待认领", blocked: "被挡", done: "已完成", cancelled: "已取消" },
    relations: { blocked_by: "被这些任务挡住", dependents: "挡住的任务", children: "子任务" },
    kinds: { note: "记录", decision: "决定", link: "链接" } },
  en: { title: "Tasks", waiting: "Waiting on you", in_progress: "In progress", open: "Open", done: "Recently done", blocked: "Blocked", all: "All projects",
    filter: "Filter by ID or title", more: (n) => `Show ${n} more`, less: "Show less",
    blockedBy: (ids) => `Blocked by ${ids.join(", ")}`, language: "Language",
    empty: "No tasks", none: "No tasks match", loading: "Loading…", error: "Can't read the board",
    back: "Back", wholeBody: "Show all", progress: "Current progress", body: "Description", parent: "Parent", you: "You", events: "Activity",
    state: { in_progress: "In progress", open: "Open", blocked: "Blocked", done: "Done", cancelled: "Cancelled" },
    relations: { blocked_by: "Blocked by", dependents: "Blocking", children: "Subtasks" },
    kinds: { note: "Note", decision: "Decision", link: "Link" } },
};

// The focused space's Herdr agents (`agents()` of that space) joined with its project's
// `nawaban json board`, as the panel draws them: a card per window waiting on you, a row per
// window stopped, done or working, and the idle ones counted. A task is in the window whose
// terminal address is its `terminal`. Each window takes the first state that holds: 等你 (it holds
// a task asking a triage question, or Herdr says blocked), 停了 (it holds an open task and Herdr says idle), 完成, 在干,
// 空闲. Durations run from the held task's latest event; Herdr records none of its own.
// `otherWaiting` sums `json projects`' waiting counts of every project but `project`.
export function windowsView({ agents, board, now, lang, projects, project }) {
  const open = (board?.columns ?? []).filter((c) => c.key !== "done").flatMap((c) => c.tasks ?? [])
    .sort((x, y) => y.active_at - x.active_at);
  const words = WINDOW_WORDS[lang];
  const windows = agents.map((a) => {
    const mine = open.filter((t) => t.terminal === a.address);
    const asking = mine.find((t) => t.waiting != null);
    const task = asking ?? mine[0];
    const blocked = !asking && a.status === "blocked";
    const state = asking || blocked ? "waiting" : task && a.status === "idle" ? "stopped"
      : a.status === "done" || a.status === "working" ? a.status : "idle";
    // Herdr records no time for `blocked` (`seq` only orders changes), so that wait has no length.
    const since = blocked ? null : task?.active_at ?? null;
    return { name: a.tab_name || a.title, ...(state === "waiting" && { question: asking?.waiting ?? words.confirm }),
      doing: task?.title ?? a.title, state, label: words[state], duration: since == null ? null : span(now - since, lang, !!asking),
      focus: a.address, seq: a.seq, since };
  });
  // A waiting task in no window of this space (its terminal unknown, or elsewhere) still asks; named by its ID.
  const strays = open.filter((t) => t.waiting != null && !agents.some((a) => a.address === t.terminal))
    .map((t) => ({ name: t.id, question: t.waiting, doing: t.title, state: "waiting", label: words.waiting,
      duration: span(now - t.active_at, lang, true), focus: null, seq: 0, since: t.active_at }));
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

// A duration in seconds: "20m", "3h", "2d" in the table; on a card, in Chinese, "20 分钟", "1 小时".
const span = (s, lang, card) => {
  if (s < 60) return lang === "zh" ? "刚刚" : "now";
  const [n, zh, en] = s < 3600 ? [s / 60, "分钟", "m"] : s < 86400 ? [s / 3600, "小时", "h"] : [s / 86400, "天", "d"];
  return lang === "zh" && card ? `${Math.floor(n)} ${zh}` : `${Math.floor(n)}${en}`;
};

export const WINDOW_WORDS = {
  zh: { waiting: "等你", stopped: "停了", done: "完成", working: "在干", idle: "空闲", confirm: "在等你确认" },
  en: { waiting: "Waiting", stopped: "Stopped", done: "Done", working: "Working", idle: "Idle", confirm: "Waiting for you to confirm" },
};

// Out-of-order answers: each call hands out a check that stays true only until the next call, so an
// answer that arrives after a newer request was sent is dropped.
export function latestOnly() {
  let n = 0;
  return () => { const me = ++n; return () => me === n; };
}

// A key pressed in the panel as one of its commands (the same names `nawaban-board.<command>`
// reaches from keys.json or `herdr-app do`), or null to leave the key alone.
const KEYS = { down: "down", up: "up", enter: "open", escape: "back" };
export const keyCommand = (e) => KEYS[e.keystroke] ?? (e.key_char === "/" ? "filter" : null);

// What Esc undoes, innermost first: the task shown ("pop"), the filter box holding the keyboard
// ("leave-filter"), the filter's text ("clear-filter"); null when there is nothing to undo.
export function escapeStep({ trail, inFilter, query }) {
  if (trail.length) return "pop";
  if (inFilter) return "leave-filter";
  return query.trim() ? "clear-filter" : null;
}
