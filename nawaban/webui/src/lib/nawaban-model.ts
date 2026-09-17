import type { AskItem, BoardResponse, BoardTask } from "./types.ts";
export const STAGES = [
  { id: "open", label: "待认领" },
  { id: "in_progress", label: "进行中" },
  { id: "staging-verified", label: "待验收" },
  { id: "done", label: "最近完成" },
] as const;
export const WAIT: Record<string, string> = {
  decision: "等拍板",
  prod: "等上线",
  observe: "等观察",
  external: "等外部",
};
export function boardItems(board: BoardResponse) {
  return board.columns.flatMap((c) =>
    c.tasks.map((t) => ({
      ...t,
      column: c.key === "claimed" ? "in_progress" : c.key,
    })),
  );
}
export function taskSignal(
  task: Pick<BoardTask, "live" | "waiting_on">,
  hasAsk: boolean,
) {
  if (hasAsk || task.waiting_on === "decision")
    return { kind: "decision", label: "需要决策，前往收件箱" };
  if (task.live?.tier === "working")
    return { kind: "working", label: "窗口正在工作" };
  if (task.live?.tier === "idle")
    return { kind: "idle", label: "窗口空闲，暂未工作" };
  if (task.live?.tier === "cold" || task.live?.tier === "no-window")
    return {
      kind: "unresponsive",
      label: task.live.tier === "cold" ? "窗口长时间无活动" : "未找到窗口",
    };
  return { kind: "unknown", label: "状态未知，暂无窗口信号" };
}
/** Relative age of the window's last activity; null when unknown. */
export function liveAge(ageS: number | null | undefined) {
  if (ageS == null) return null;
  if (ageS < 60) return "刚刚有活动";
  for (const [unit, n] of [["天", 86400], ["小时", 3600], ["分钟", 60]] as const)
    if (ageS >= n) return `最后活动 ${Math.floor(ageS / n)} ${unit}前`;
  return null;
}
export function inboxMatches(
  a: Pick<AskItem, "id" | "question" | "evidence" | "task_ids">,
  query: string,
) {
  const q = query.trim().toLowerCase();
  return [String(a.id), a.question, a.evidence, ...a.task_ids].some((v) =>
    v.toLowerCase().includes(q),
  );
}
type TaskNavigation =
  { type: "open"; id: string } | { type: "back" } | { type: "close" };
export function navigateTask(path: string[], action: TaskNavigation) {
  if (action.type === "close") return [];
  if (action.type === "back") return path.slice(0, -1);
  return path.at(-1) === action.id ? path : [...path, action.id];
}

// Older task records pack multiple scope paths into one comma-separated item.
export function textItems(value: string[] | string | null | undefined): string[] {
  return typeof value === "string" ? [value] : (value ?? []);
}

export function scopePaths(touches: string[] | null) {
  return (touches ?? [])
    .flatMap((value) => value.split(/[,\n]+/))
    .map((path) => path.trim())
    .filter(Boolean);
}

// Preserve the persisted formatting-decision key when reading existing task histories.
export const CONTEXT_LAYOUT_QUESTION = "来由排版（Markdown）";
export function contextPresentation(
  decisions: { id: number; question: string; verdict: string }[],
) {
  return (
    decisions
      .filter((d) => d.question === CONTEXT_LAYOUT_QUESTION)
      .sort((a, b) => b.id - a.id)[0]?.verdict ?? null
  );
}
// Markdown block syntax at a line start: list, heading, quote, table, fence, rule.
const MD_BLOCK = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|---)/m;
/** Plain line-separated context read as a bullet list; short "label:" leads are bolded. */
export function contextMarkdown(text: string) {
  if (MD_BLOCK.test(text)) return text;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return text;
  return lines
    .map((l) => `- ${l.replace(/^([^:：「」]{1,16})([:：])(?!\/\/)/, "**$1**$2")}`)
    .join("\n");
}
export function taskIdFromHref(href: string | undefined) {
  return href?.startsWith("?")
    ? new URLSearchParams(href.slice(1)).get("task")
    : null;
}
