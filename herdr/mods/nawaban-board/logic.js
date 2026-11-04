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

export const WORDS = {
  zh: { in_progress: "进行中", open: "待认领", done: "最近完成", blocked: "被挡", all: "全部项目",
    empty: "没有任务", loading: "读取中…", error: "读不到看板" },
  en: { in_progress: "In progress", open: "Open", done: "Recently done", blocked: "Blocked", all: "All projects",
    empty: "No tasks", loading: "Loading…", error: "Can't read the board" },
};
