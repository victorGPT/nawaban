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
      doing: blocked ? a.title : task?.title ?? a.title, state, label: words[state], duration: since == null ? null : span(now - since, lang, !!asking),
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
