import { t as tr, useLocale } from "@/i18n";
import { useEffect, useState } from "react";
import { RiArrowLeftLine } from "@remixicon/react";
import { CopyBtn } from "@/components/disclosure/CopyBtn";
import { Md } from "@/components/Md";
import { NawabanDialog, LoadState } from "@/components/NawabanUI";
import { Activity } from "@/components/task-detail/Activity";
import { Criteria } from "@/components/task-detail/Criteria";
import { Decisions } from "@/components/task-detail/Decisions";
import { Dependencies } from "@/components/task-detail/Dependencies";
import { Links } from "@/components/task-detail/Links";
import { Properties } from "@/components/task-detail/Properties";
import { ResumeBlock } from "@/components/task-detail/ResumeBlock";
import { H } from "@/components/task-detail/parts";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { fetchTask } from "@/lib/api";
import { eventMarkdown, showsProgress, splitCriteria } from "@/lib/nawaban-model";
import type { TaskDetail } from "@/lib/types";

export function TaskDetailSheet({
  taskId,
  onOpenChange,
  onSelectTask,
  onBack,
}: {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectTask: (taskId: string) => void;
  onBack?: () => void;
}) {
  useLocale();
  const [d, setD] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    setD(null);
    setError(null);
    fetchTask(taskId)
      .then((task) => active && setD(task))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [taskId]);

  const { body, criteria } = splitCriteria(d?.body ?? "");
  // A closed task's latest note can be stale (migrated tasks keep their last progress line).
  const progress = d && showsProgress(d.status) ? d.latest_note : null;
  return (
    <NawabanDialog
      open={taskId != null}
      onClose={() => onOpenChange(false)}
      title={tr("taskDetails", { id: taskId ?? "" })}
      wide
      header={
        <div className="detail-breadcrumb">
          {onBack && (
            <Button
              variant="ghost"
              size="xs"
              onClick={onBack}
            ><RiArrowLeftLine aria-hidden="true" />{tr("back")}</Button>
          )}
          <span>{d?.project ?? tr("task")} / </span>
          <code>{taskId}</code>
          {taskId && <CopyBtn text={taskId} />}
        </div>
      }
    >
      {error && <LoadState error>{error}</LoadState>}
      {!d && !error && <LoadState>{tr("loadingTasks")}</LoadState>}
      {d && (
        <div className="detail-scroll">
          <div className="detail-grid">
            <main className="detail-reading">
              <div className="flex flex-col gap-4">
                <h2 className="detail-task-title">{d.title}</h2>
                {progress && (
                  <SettingsCard className="detail-now">
                    <span className="detail-subheading">{tr("currentProgress")}</span>
                    <Md text={eventMarkdown(progress.body)} onSelectTask={onSelectTask} />
                  </SettingsCard>
                )}
              </div>

              {body && (
                <section>
                  <H>{tr("context")}</H>
                  <Md className="context-markdown" text={body} callouts onSelectTask={onSelectTask} />
                </section>
              )}
              <Criteria criteria={criteria} onSelectTask={onSelectTask} />
              <Dependencies blockedBy={d.blocked_by} dependents={d.dependents} onSelectTask={onSelectTask} />
              <Decisions decisions={d.decisions} />
              <Links links={d.links} />
              <Activity events={d.events} />
            </main>

            <aside className="detail-properties-rail">
              {d.session && <ResumeBlock session={d.session} />}
              <Properties d={d} onSelectTask={onSelectTask} />
            </aside>
          </div>
        </div>
      )}
    </NawabanDialog>
  );
}
