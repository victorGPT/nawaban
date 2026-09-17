import { useSyncExternalStore } from "react";
import en from "./en.json";
import zhCN from "./zh-CN.json";

export type Locale = "en" | "zh-CN";
export type TranslationKey = keyof typeof en;
const messages: Record<Locale, Record<TranslationKey, string>> = { en, "zh-CN": zhCN };
const storageKey = "nawaban.locale";

function initialLocale(): Locale {
  // Browser storage can be denied by privacy settings or embedded contexts.
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch { /* Use the browser language when storage is unavailable. */ }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

let locale = initialLocale();
document.documentElement.lang = locale;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => locale);
}

export function setLocale(next: Locale): void {
  locale = next;
  document.documentElement.lang = next;
  try { localStorage.setItem(storageKey, next); }
  catch { /* Switching still works when browser storage is unavailable. */ }
  listeners.forEach((listener) => listener());
}

export function t(key: TranslationKey, values: Record<string, string | number> = {}): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

const statuses: Record<string, TranslationKey> = {
  open: "unassigned", claimed: "assigned", in_progress: "inProgress",
  "staging-verified": "ready", done: "done", cancelled: "cancelled",
};
const waiting: Record<string, TranslationKey> = {
  decision: "waitDecision", prod: "waitDeploy", observe: "waitObserve", external: "waitExternal",
};

// Unknown values received from a newer server remain visible as their raw identifiers.
export const statusLabel = (status: string) => statuses[status] ? t(statuses[status]) : status;
export const waitingLabel = (value: string) => waiting[value] ? t(waiting[value]) : value;
