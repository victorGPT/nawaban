import { useSyncExternalStore } from "react";

let now = Date.now() / 1000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval>;
const snapshot = () => now;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now() / 1000;
    // All cards share one clock, including when API refreshes are failing.
    timer = setInterval(() => {
      now = Date.now() / 1000;
      listeners.forEach((notify) => notify());
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
  };
};

export function useTaskClock() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
