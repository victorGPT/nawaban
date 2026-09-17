import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LinkButton } from "@/components/base/buttons/link-button";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { taskIdFromHref } from "@/lib/nawaban-model";
import { cn } from "@/lib/utils";

// Shared Markdown typography lives in styles/nawaban-typography.css.

export function Md({
  text,
  className,
  inline,
  onSelectTask,
  callouts = false,
}: {
  text: string;
  className?: string;
  inline?: boolean;
  onSelectTask?: (id: string) => void;
  callouts?: boolean;
}) {
  return (
    <div className={cn("nawaban-prose", inline && "[&_p]:inline", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const taskId = taskIdFromHref(href);
            if (!href) return <span>{children}</span>;
            return (
              <LinkButton
                href={href}
                size="small"
                className="markdown-link"
                onClick={(event) => {
                  if (
                    taskId &&
                    onSelectTask &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    onSelectTask(taskId);
                  }
                }}
              >
                {children}
              </LinkButton>
            );
          },
          ...(callouts
            ? {
                blockquote: ({ children }: { children?: React.ReactNode }) => (
                  <SettingsCard className="context-callout">
                    {children}
                  </SettingsCard>
                ),
              }
            : {}),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
