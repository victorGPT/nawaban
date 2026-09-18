import { BOARD_COLUMNS } from "./nawaban-model.ts";
import type { BoardTask } from "./types.ts";

export const BOARD_DISPLAY_STORAGE = "nawaban.boardDisplay";
export const SORT_OPTIONS = ["default", "updated", "created", "title"] as const;
export const DISPLAY_FIELDS = ["id", "module"] as const;
export type BoardDisplay = {
  columns: string[];
  sort: typeof SORT_OPTIONS[number];
  compact: boolean;
  fields: string[];
};

// URL and persisted preferences are user-controlled input. Explicit empty lists
// mean "hide all"; absent values retain defaults, and obsolete IDs are ignored.
// A nonempty selection with no recognized IDs falls back to all allowed values.
export function readBoardDisplay(search: string, saved: string | null): BoardDisplay {
  const url = new URLSearchParams(search);
  const local = new URLSearchParams(saved ?? "");
  const value = (key: string) => url.get(key) ?? local.get(key);
  const columns = BOARD_COLUMNS.map((column) => column.id);
  const selected = (key: string, allowed: readonly string[]) => {
    const raw = value(key);
    if (raw === null) return [...allowed];
    const matches = allowed.filter((id) => raw.split(",").includes(id));
    return raw !== "" && matches.length === 0 ? [...allowed] : matches;
  };
  return {
    columns: selected("boardColumns", columns),
    sort: SORT_OPTIONS.find((sort) => sort === value("boardSort")) ?? "default",
    compact: value("boardDensity") === "compact",
    fields: selected("boardFields", DISPLAY_FIELDS),
  };
}

export function writeBoardDisplay(params: URLSearchParams, display: BoardDisplay) {
  params.set("boardColumns", display.columns.join(","));
  params.set("boardSort", display.sort);
  params.set("boardDensity", display.compact ? "compact" : "comfortable");
  params.set("boardFields", display.fields.join(","));
  return params;
}

export function sortBoardTasks<T extends BoardTask>(tasks: T[], sort: BoardDisplay["sort"], locale: string): T[] {
  if (sort === "default") return tasks;
  return [...tasks].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title, locale);
    return sort === "created" ? b.created_at - a.created_at : b.active_at - a.active_at;
  });
}
