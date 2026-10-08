import { t as tr } from "../i18n/index.ts";
import type {
  AnswerResponse,
  BoardResponse,
  DateRange,
  InboxResponse,
  KinResponse,
  ModulesResponse,
  Project,
  ProjectsResponse,
  TaskDetail,
} from "./types.ts";

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
export const fetchModules = (project: Project = null) =>
  getJSON<ModulesResponse>(withProject("/api/modules", project));
export const fetchInbox = (project: Project = null) =>
  getJSON<InboxResponse>(withProject("/api/inbox", project));
export const fetchProjects = () => getJSON<ProjectsResponse>("/api/projects");
export const fetchTask = (id: string) =>
  getJSON<TaskDetail>(`/api/task?id=${encodeURIComponent(id)}`);
export const fetchKin = (id: string) =>
  getJSON<KinResponse>(`/api/kin?id=${encodeURIComponent(id)}`);

export class AnswerError extends Error {
  unknown: boolean;
  constructor(message: string, unknown = false) {
    super(message);
    this.unknown = unknown;
  }
}

export async function postAnswer(
  ask_id: number,
  verdict: string,
  reject: boolean,
): Promise<AnswerResponse> {
  // A transport or JSON failure after POST cannot prove that no decision was recorded.
  let r: Response;
  let body: AnswerResponse;
  try {
    r = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ask_id, verdict, reject }),
    });
    body = (await r.json()) as AnswerResponse;
  } catch {
    throw new AnswerError(tr("unknownAnswer"), true);
  }
  if (!r.ok || !body.ok)
    throw new AnswerError(
      body.unknown
        ? tr("unknownAnswer")
        : body.out || `HTTP ${r.status}`,
      body.unknown === true,
    );
  return body;
}
