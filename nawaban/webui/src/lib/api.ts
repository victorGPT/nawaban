import type {
  BoardResponse,
  DateRange,
  Project,
  ProjectsResponse,
  TaskDetail,
} from "./types.ts";

// The board API is read-only: every request here is a GET.
async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export type { DateRange, Project };
const withProject = (path: string, project: Project, params = new URLSearchParams()) => {
  if (project === "") params.set("unassigned", "1");
  else if (project !== null) params.set("project", project);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};
export const fetchBoard = (range?: DateRange | null, project: Project = null) =>
  getJSON<BoardResponse>(
    withProject("/api/board", project, new URLSearchParams(range ?? {})),
  );
export const fetchProjects = () => getJSON<ProjectsResponse>("/api/projects");
export const fetchTask = (id: string) =>
  getJSON<TaskDetail>(`/api/task?id=${encodeURIComponent(id)}`);
