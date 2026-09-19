import { cx } from "@/utils/cx";

/**
 * clsx-compatible argument shape, matching the signature of shadcn's own `cn`.
 * The generated `components/ui/*` files forward Base UI's `className` prop,
 * whose type is `string | ((state) => string | undefined)`, so `cn` has to
 * accept that union. Function values are ignored — same as clsx (and same as
 * upstream `cn`, where a function matches its `ClassDictionary` branch and
 * contributes no keys).
 */
export type ClassValue =
  | ClassValue[]
  | Record<string, unknown>
  | ((...args: never[]) => unknown)
  | string
  | number
  | bigint
  | null
  | boolean
  | undefined;

function flatten(value: ClassValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(" ");
  if (typeof value === "object" && value !== null) {
    return Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key])
      .join(" ");
  }
  return "";
}

/** Merge Tailwind classes, aware of BoardUI's composite `text-*` utilities. */
export function cn(...inputs: ClassValue[]): string {
  return cx(inputs.map(flatten).filter(Boolean).join(" "));
}

// Owner initials are the first two characters after the namespace colon.
// Relative elapsed time, such as "5m", "3h" or "1.2d".
export function ago(ts: number | null | undefined): string {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
