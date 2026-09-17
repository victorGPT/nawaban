// 与 board_view.py 的只读投影一一对应(board_data / modules_data / inbox_data)。
// 别在这里加服务端没给的字段 —— 有出入先去读 board_view.py,不要猜。

export type Live = { tier: string; age_s: number | null } | null;

export type BoardTask = {
  id: string;
  title: string;
  status: string;
  waiting_on: string | null;
  owner: string | null;
  epic: string | null;
  now: string | null;
  created_at: number;
  fold: string;
  started_at: number | null;
  completed_at: number | null;
  active_at: number;
  dep?: { blocked_by?: string[]; blocks?: string[] };
  live?: Live;
  merged_refs?: string[]; // open 卡却已有 pr/merge_sha 引用(巡检「未开工却有 merged PR」同口径)
};

export type BoardColumn = {
  key: string;
  title: string;
  color: string;
  tasks: BoardTask[];
  live_tally?: Record<string, number>;
};

export type BoardResponse = {
  columns: BoardColumn[];
  liveness: { available: boolean; complete: boolean; busy_window_s: number; idle_window_s: number };
};

export type ModuleTask = { i: string; t: string; s: string; e: string };
export type ModulesResponse = { tasks: ModuleTask[]; deps: [string, string][]; unavailable?: boolean };

export type AskItem = {
  id: number;
  kind: "authorize" | "accept" | "decide";
  question: string;
  evidence: string;
  options: unknown;
  blast: unknown;
  hands_on: boolean;
  raised_at: number;
  raised_by: string;
  closed_at: number | null;
  closed_as: string | null;
  answer: string | null;
  decision_id: number | null;
  confidence: number | null;
  confidence_reason: string | null;
  stalled_days: number;
  task_ids: string[];
};

export type AskGroup = { kind: string; title: string; items: AskItem[] };

export type SelfApproved = {
  id: string;
  title: string;
  completed_at: number | null;
  evidence: string | null;
  self_evident: boolean;
};

export type InboxResponse = {
  total: number;
  oldest_days: number;
  unavailable?: boolean;
  groups: AskGroup[];
  flow: { raised_7d: number; closed_7d: number };
  agent_side: number;
  self_approved?: SelfApproved[]; // board_view.inbox_data 目前不返回这个键(2026-09-07 实测)
};

export type AnswerResponse = { ok: boolean; out: string; unknown?: boolean };

// task_detail() 的完整投影(board_view.py) —— 卡详情侧栏用。
export type TaskEdge = {
  kind: string;
  other: string;
  dir: "in" | "out";
  note: string | null;
  other_title: string;
  other_status: string;
  other_waiting_on: string | null;
};

export type TaskDecision = {
  id: number;
  question: string;
  verdict: string;
  rejected: unknown;
  decided_by: string;
  adr: string | null;
  supersedes: number | null;
  created_at: number;
};

export type TaskEvent = {
  kind: string;
  body: string;
  author: string | null;
  session_id: string | null;
  created_at: number;
};

export type TaskRef = { kind: string; value: string; note: string | null; created_at: number };

export type KinTask = {
  id: string;
  title: string;
  status: string;
};

export type KinResponse = {
  blocked_by: (KinTask & { depth: number })[];
  stuck_at: string | null;
  unblocks: (KinTask & { others_waiting: number })[];
  lineage: {
    split_from: string | null;
    split_out: string[];
    supersedes: string[];
    superseded_by: string[];
    latest_decision: string | null;
  };
  epic: string | null;
};

export type TaskSession = {
  owner: string;
  session_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  summary: string | null;
  note: string | null;
};

export type TaskLetter = {
  id: number;
  kind: string;
  msg: string;
  links: unknown;
  session_id: string | null;
  created_at: number;
  read_at: number | null;
};

export type TaskDetail = BoardTask & {
  context: string | null;
  adr: string | null;
  success: string[] | null;
  constraints: string[] | null;
  touches: string[] | null;
  edges_out: TaskEdge[];
  edges_in: TaskEdge[];
  decisions: TaskDecision[];
  events: TaskEvent[];
  refs: TaskRef[];
  sessions: TaskSession[];
  letters: TaskLetter[];
};
