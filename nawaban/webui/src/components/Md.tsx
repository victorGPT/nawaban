import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// 卡上的正文字段(now / context / 判据 / 决策 / 事件 / summary)是 agent 用 markdown 写的,
// 原来当纯文本渲染,**加粗** 和 `代码` 满屏裸露。react-markdown 默认不渲染 raw HTML,安全。
// 没装 typography 插件,排版规则手写在这里,跟卡详情的尺度一致(正文 15/24 · 列表 sm · 代码 xs mono)。
const PROSE =
  "break-words [&_p]:my-0 [&_p+p]:mt-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li+li]:mt-0.5 " +
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.85em] " +
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_h1]:text-base [&_h2]:text-base [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_hr]:my-3 [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1";

export function Md({ text, className, inline }: { text: string; className?: string; inline?: boolean }) {
  return (
    <div className={cn(PROSE, inline && "[&_p]:inline", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
