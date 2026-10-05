import { t as tr } from "@/i18n";

export function rel(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return tr("justNow");
  if (s < 3600) return tr("minutesAgo", { count: Math.floor(s / 60) });
  if (s < 86400) return tr("hoursAgo", { count: Math.floor(s / 3600) });
  return tr("daysAgo", { count: Math.floor(s / 86400) });
}

export const isUrl = (v: string) => /^https?:\/\/\S+$/.test(v.trim());
