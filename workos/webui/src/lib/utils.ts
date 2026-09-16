import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// index.css 里自定义了字号 `text-ui`(13/20)。tailwind-merge 不认识的 text-* 一律当颜色,
// 于是 cn("text-ui", "text-fg-secondary") 会把 text-ui 合并掉(2026-09-07 模块卡标题变 16px 的真因)。
const twMerge = extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: ["ui"] }] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// owner 形如 "ac:622388e9" / "ac/main:w-arch" —— 取冒号后前两位当头像字符。
// 相对时长:1788842426 → "5m" / "3h" / "1.2d"
export function ago(ts: number | null | undefined): string {
  if (!ts) return ""
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${(s / 86400).toFixed(1)}d`
}
