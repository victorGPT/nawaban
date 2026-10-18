import { t as tr, statusLabel } from "../i18n/index.ts";
import type { BoardResponse } from "./types.ts";

// One lane per board column; cancelled tasks are not on the board.
export const BOARD_COLUMNS = [
  { id: "open", states: ["open"], get label() { return statusLabel("open"); } },
  { id: "in_progress", states: ["in_progress"], get label() { return statusLabel("in_progress"); } },
  { id: "done", states: ["done"], get label() { return tr("recentDone"); } },
] as const;

export function boardItems(board: BoardResponse) {
  return board.columns.flatMap((c) =>
    c.tasks.map((t) => ({
      ...t,
      column: c.key,
    })),
  );
}

type TaskNavigation =
  { type: "open"; id: string } | { type: "back" } | { type: "close" };
export function navigateTask(path: string[], action: TaskNavigation) {
  if (action.type === "close") return [];
  if (action.type === "back") return path.slice(0, -1);
  return path.at(-1) === action.id ? path : [...path, action.id];
}

// The acceptance-criteria section of a task body (MATT ticket template), when present.
// Chinese headings are escaped: UI source holds no CJK text (see tests/test_glossary.py).
const CRITERIA = /^(#{1,6})\s*(acceptance criteria|\u9a8c\u6536\u6807\u51c6|\u9a8c\u6536\u5224\u636e)\s*$/im;
export function splitCriteria(body: string): { body: string; criteria: string | null } {
  const m = CRITERIA.exec(body);
  if (!m) return { body, criteria: null };
  const rest = body.slice(m.index + m[0].length);
  // The section runs to the next heading of the same or a higher level.
  const next = new RegExp(`^#{1,${m[1].length}}\\s`, "m").exec(rest);
  const criteria = (next ? rest.slice(0, next.index) : rest).trim();
  const before = body.slice(0, m.index).trimEnd();
  const after = next ? rest.slice(next.index) : "";
  return {
    body: [before, after].filter(Boolean).join("\n\n"),
    criteria: criteria || null,
  };
}

/** A link event body: `[kind:] value [· note]`, as `pr: https://…` or a migrated `pr:url · note`. */
export function linkParts(body: string): { kind: string | null; value: string; note: string | null } {
  const m = /^([a-z][\w-]*):(?!\/\/)\s*([\s\S]*)$/i.exec(body.trim());
  const rest = m ? m[2] : body.trim();
  const at = rest.indexOf(" · ");
  return {
    kind: m ? m[1] : null,
    value: at < 0 ? rest : rest.slice(0, at),
    note: at < 0 ? null : rest.slice(at + 3),
  };
}

/** The latest note reads as current progress only while the task is not closed. */
export const showsProgress = (status: string) => status === "open" || status === "in_progress";

export function taskIdFromHref(href: string | undefined) {
  return href?.startsWith("?")
    ? new URLSearchParams(href.slice(1)).get("task")
    : null;
}
