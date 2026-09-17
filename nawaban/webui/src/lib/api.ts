import type {
  AnswerResponse,
  BoardResponse,
  InboxResponse,
  KinResponse,
  ModulesResponse,
  TaskDetail,
} from "./types";

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export type DateRange = { since: string; until: string };
export const fetchBoard = (range?: DateRange | null) =>
  getJSON<BoardResponse>(
    range ? `/api/board?since=${range.since}&until=${range.until}` : "/api/board"
  );
export const fetchModules = () => getJSON<ModulesResponse>("/api/modules");
export const fetchInbox = () => getJSON<InboxResponse>("/api/inbox");
export const fetchTask = (id: string) => getJSON<TaskDetail>(`/api/task?id=${encodeURIComponent(id)}`);
export const fetchKin = (id: string) => getJSON<KinResponse>(`/api/kin?id=${encodeURIComponent(id)}`);

export async function postAnswer(ask_id: number, verdict: string, reject: boolean): Promise<AnswerResponse> {
  const r = await fetch("/api/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ask_id, verdict, reject }),
  });
  const body = (await r.json()) as AnswerResponse;
  if (!r.ok) throw new Error(body.out || `HTTP ${r.status}`);
  return body;
}
