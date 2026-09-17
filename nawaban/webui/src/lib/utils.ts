// Register text-ui as a font size so tailwind-merge does not treat it as a color.
import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const twMerge = extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: ["ui"] }] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return ""
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${(s / 86400).toFixed(1)}d`
}
