// Pure logic of the nawaban-board mod: no "herdr" or "gpui-kit" imports, so `node --test` runs it.

const ORDER = ["in_progress", "open", "done"];

// `nawaban json board` columns as the panel lists them: in progress, open (tasks that can start
// first, blocked ones last and marked), recently done. The board's own order is kept within each.
export function groupTasks(board) {
  const byKey = Object.fromEntries((board?.columns ?? []).map((c) => [c.key, c.tasks ?? []]));
  return ORDER.map((key) => {
    const tasks = (byKey[key] ?? []).map((t) => ({ ...t, blocked: key === "open" && t.open_blockers > 0 }));
    return { key, tasks: [...tasks.filter((t) => !t.blocked), ...tasks.filter((t) => t.blocked)] };
  });
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

// The groups the panel shows: tasks whose ID or title holds the filter text, then the status
// chip: "all", or one kind ("in_progress", "open" that can start, "blocked").
export function filterGroups(groups, query, chip) {
  const q = query.trim().toLowerCase();
  const hit = (t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
  const kept = groups.map((g) => ({ ...g, tasks: g.tasks.filter(hit) }));
  if (chip === "all") return kept;
  const key = chip === "blocked" ? "open" : chip;
  return kept.filter((g) => g.key === key)
    .map((g) => (key === "open" ? { ...g, tasks: g.tasks.filter((t) => t.blocked === (chip === "blocked")) } : g));
}

// The list as one run of rows, the way the panel draws and the keyboard walks it: each group's
// heading, then (unless folded) its rows that can start, the "show N more" row when the group is
// longer than `shown` allows, and its blocked rows last, so their mark is never cut. A filtered list
// neither folds nor cuts, and drops groups without a match.
export function listRows(groups, { narrowed, shut, expanded, shown }) {
  const rows = [];
  for (const g of groups) {
    if (narrowed && !g.tasks.length) continue;
    rows.push({ key: `head:${g.key}`, kind: "head", group: g });
    if (!narrowed && shut.has(g.key)) continue;
    const free = g.tasks.filter((t) => !t.blocked), blocked = g.tasks.filter((t) => t.blocked);
    const limit = shown[g.key] ?? Infinity;
    const cut = narrowed || expanded.has(g.key) ? 0 : Math.max(0, free.length - limit);
    const task = (t) => rows.push({ key: `task:${t.id}`, kind: "task", task: t });
    free.slice(0, free.length - cut).forEach(task);
    if (!narrowed && free.length > limit) rows.push({ key: `more:${g.key}`, kind: "more", group: g, cut });
    blocked.forEach(task);
  }
  return rows;
}

// The row the up (-1) or down (+1) arrow selects from `key`; it stops at either end. With nothing
// selected, or a row no longer listed, down starts at the top and up at the bottom.
export function moveSelection(rows, key, delta) {
  if (!rows.length) return null;
  const at = rows.findIndex((r) => r.key === key);
  if (at < 0) return rows[delta > 0 ? 0 : rows.length - 1].key;
  return rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key;
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

// A link event body, `[kind:] value [· note]`, read as the web board reads it (nawaban/webui/src/
// lib/nawaban-model.ts linkParts); `url` is the value when a browser can open it.
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

export const WORDS = {
  zh: { title: "任务", in_progress: "进行中", open: "待认领", done: "最近完成", blocked: "被挡", all: "全部项目",
    statuses: "全部", filter: "按 ID 或标题过滤", more: (n) => `再显示 ${n} 条`, less: "收起",
    blockedBy: (ids) => `被 ${ids.join("、")} 挡住`, language: "语言",
    empty: "没有任务", none: "没有匹配的任务", loading: "读取中…", error: "读不到看板",
    back: "返回", wholeBody: "显示全文", progress: "当前进度", body: "正文", parent: "上级", user: "用户", events: "事件",
    state: { in_progress: "进行中", open: "待认领", blocked: "被挡", done: "已完成", cancelled: "已取消" },
    relations: { blocked_by: "被这些任务挡住", dependents: "挡住的任务", children: "子任务" },
    kinds: { note: "记录", decision: "决定", link: "链接" } },
  en: { title: "Tasks", in_progress: "In progress", open: "Open", done: "Recently done", blocked: "Blocked", all: "All projects",
    statuses: "All", filter: "Filter by ID or title", more: (n) => `Show ${n} more`, less: "Show less",
    blockedBy: (ids) => `Blocked by ${ids.join(", ")}`, language: "Language",
    empty: "No tasks", none: "No tasks match", loading: "Loading…", error: "Can't read the board",
    back: "Back", wholeBody: "Show all", progress: "Current progress", body: "Description", parent: "Parent", user: "user", events: "Activity",
    state: { in_progress: "In progress", open: "Open", blocked: "Blocked", done: "Done", cancelled: "Cancelled" },
    relations: { blocked_by: "Blocked by", dependents: "Blocking", children: "Subtasks" },
    kinds: { note: "Note", decision: "Decision", link: "Link" } },
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
