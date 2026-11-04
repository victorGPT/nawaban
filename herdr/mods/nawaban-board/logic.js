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

// How long ago an epoch-seconds time was, short.
export function ago(at, now, lang) {
  const s = Math.max(0, now - at);
  if (s < 60) return lang === "zh" ? "刚刚" : "just now";
  const [n, zh, en] = s < 3600 ? [s / 60, "分钟", "m"] : s < 86400 ? [s / 3600, "小时", "h"] : [s / 86400, "天", "d"];
  return lang === "zh" ? `${Math.floor(n)} ${zh}前` : `${Math.floor(n)}${en} ago`;
}

export const WORDS = {
  zh: { title: "任务", in_progress: "进行中", open: "待认领", done: "最近完成", blocked: "被挡", all: "全部项目",
    statuses: "全部", filter: "按 ID 或标题过滤", more: (n) => `再显示 ${n} 条`, less: "收起",
    blockedBy: (ids) => `被 ${ids.join("、")} 挡住`, language: "语言",
    empty: "没有任务", none: "没有匹配的任务", loading: "读取中…", error: "读不到看板" },
  en: { title: "Tasks", in_progress: "In progress", open: "Open", done: "Recently done", blocked: "Blocked", all: "All projects",
    statuses: "All", filter: "Filter by ID or title", more: (n) => `Show ${n} more`, less: "Show less",
    blockedBy: (ids) => `Blocked by ${ids.join(", ")}`, language: "Language",
    empty: "No tasks", none: "No tasks match", loading: "Loading…", error: "Can't read the board" },
};
