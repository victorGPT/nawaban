import { t as tr, useLocale } from "@/i18n";
import { useState } from "react";
import { Md } from "@/components/Md";
import { LinkButton } from "@/components/base/buttons/link-button";
import { contextMarkdown, contextPresentation } from "@/lib/nawaban-model";
import type { TaskDecision } from "@/lib/types";

export function TaskContext({
  context,
  decisions,
  onSelectTask,
}: {
  context: string;
  decisions: TaskDecision[];
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  const [showOriginal, setShowOriginal] = useState(false);
  const formatted = contextPresentation(decisions);
  return (
    <div className="task-context">
      <Md
        text={formatted ?? contextMarkdown(context)}
        className="context-markdown"
        callouts
        onSelectTask={onSelectTask}
      />
      {formatted && (
        <>
          <LinkButton
            size="xs"
            className="detail-action"
            variant="secondary"
            aria-expanded={showOriginal}
            onClick={() => setShowOriginal(!showOriginal)}
          >
            {showOriginal ? tr("collapseOriginal") : tr("viewOriginal")}
          </LinkButton>
          {showOriginal && (
            <div className="context-original">
              <Md text={context} onSelectTask={onSelectTask} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
