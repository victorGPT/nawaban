import { type Project } from "./api";

export type Capture = {
  id: string;
  content: string;
  project: string | null;
  status: "pending" | "converted" | "discarded";
  task_id: string | null;
  reason: string | null;
  created_at: number;
  created_by: string;
  resolved_at: number | null;
  resolved_by: string | null;
};
export type CaptureDraft = { id: string; content: string; project: Project };

export function newCaptureId(): string {
  // getRandomValues also works on the supported HTTP tailnet origin.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function fetchCaptures(project: Project): Promise<Capture[]> {
  const params = new URLSearchParams({ status: "all" });
  if (project === "") params.set("unassigned", "1");
  else if (project !== null) params.set("project", project);
  const response = await fetch(`/api/captures?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).items;
}

export class CaptureError extends Error {
  unknown: boolean;
  constructor(message: string, unknown: boolean) {
    super(message);
    this.unknown = unknown;
  }
}

export async function postCapture(draft: CaptureDraft): Promise<Capture> {
  let response: Response;
  let body: { ok: boolean; item: Capture; unknown?: boolean; out?: string; error?: string };
  try {
    response = await fetch("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    body = await response.json();
  } catch {
    // A lost response cannot prove that the CLI did not commit the idea.
    throw new CaptureError("", true);
  }
  if (!response.ok || !body.ok)
    throw new CaptureError(body.out || body.error || `HTTP ${response.status}`, body.unknown === true);
  return body.item;
}
