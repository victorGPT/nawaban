export { cx as cn } from "@/utils/cx";
// Owner initials are the first two characters after the namespace colon.
// Relative elapsed time, such as "5m", "3h" or "1.2d".
export function ago(ts: number | null | undefined): string {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
