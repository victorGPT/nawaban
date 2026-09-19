// Tune task inactivity independently of session liveness, in seconds.
export const TASK_STALE_THRESHOLDS = {
  warning: 3 * 24 * 60 * 60,
  critical: 7 * 24 * 60 * 60,
} as const;

export function taskStaleness(activeAt: number | undefined, now: number) {
  // Older module API responses do not include an activity timestamp.
  if (activeAt === undefined) return null;
  const age = now - activeAt;
  if (age < TASK_STALE_THRESHOLDS.warning) return null;
  return {
    days: Math.floor(age / 86400),
    level: age >= TASK_STALE_THRESHOLDS.critical ? "critical" as const : "warning" as const,
  };
}
