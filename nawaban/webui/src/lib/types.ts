// Match the board_view read projections (/api/projects, /api/board, /api/task).
// Add fields only when the backend projection supplies them.

export type DateRange = { since: string; until: string };
/** null = all projects; empty string = unassigned tasks. */
export type Project = string | null;

/** open / done / cancelled are stored; in_progress is derived (a session holds an open task). */
export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export type BoardTask = {
  id: string;
  title: string;
  status: TaskStatus;
  project: string | null;
  parent: string | null;
  session: string | null;
  created_at: number;
  active_at: number;
  open_blockers: number;
};

export type BoardColumn = { key: string; tasks: BoardTask[] };
export type BoardResponse = { columns: BoardColumn[] };

export type ProjectsResponse = {
  projects: { name: string | null; open: number; total: number }[];
};

export type TaskRef = { id: string; title: string; status: TaskStatus };

export type TaskEvent = {
  kind: "note" | "status" | "decision" | "link";
  body: string;
  author: string;
  at: number;
};

export type TaskDetail = {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  project: string | null;
  session: string | null;
  created_at: number;
  parent: TaskRef | null;
  children: TaskRef[];
  blocked_by: TaskRef[];
  dependents: TaskRef[];
  latest_note: TaskEvent | null;
  decisions: TaskEvent[];
  links: TaskEvent[];
  /** Newest first. */
  events: TaskEvent[];
};
