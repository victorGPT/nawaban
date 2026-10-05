import { t as tr, useLocale } from "@/i18n";
import { useEffect, useState } from "react";
import { RiArrowLeftLine } from "@remixicon/react";
import { CopyBtn } from "@/components/disclosure/CopyBtn";
import { Md } from "@/components/Md";
import { NawabanDialog, LoadState } from "@/components/NawabanUI";
import { Activity } from "@/components/task-detail/Activity";
import { CaptureOrigin } from "@/components/task-detail/CaptureOrigin";
import { ContextSection } from "@/components/task-detail/ContextSection";
import { Criteria } from "@/components/task-detail/Criteria";
import { Decisions } from "@/components/task-detail/Decisions";
import { Dependencies } from "@/components/task-detail/Dependencies";
import { Evidence } from "@/components/task-detail/Evidence";
import { Properties } from "@/components/task-detail/Properties";
import { Relationships } from "@/components/task-detail/Relationships";
import { ResumeBlock } from "@/components/task-detail/ResumeBlock";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { fetchKin, fetchTask } from "@/lib/api";
import type { KinResponse, TaskDetail } from "@/lib/types";

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
  const [kin, setKin] = useState<KinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    setD(null);
    setKin(null);
    setError(null);
    Promise.all([fetchTask(taskId), fetchKin(taskId)])
      .then(([task, relationships]) => {
        if (!active) return;
        setD(task);
        setKin(relationships);
      })
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [taskId]);

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
          <span>{d?.epic ?? tr("task")} / </span>
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
                {d.now && (
                  <SettingsCard className="detail-now">
                    <span className="detail-subheading">{tr("currentProgress")}</span>
                    <Md text={d.now} />
                  </SettingsCard>
                )}
              </div>

              <CaptureOrigin captures={d.captures} />
              <ContextSection d={d} onSelectTask={onSelectTask} />
              <Criteria d={d} />
              <Dependencies kin={kin} onSelectTask={onSelectTask} />
              <Decisions decisions={d.decisions} />
              <Evidence refs={d.refs} />
              <Activity d={d} />
            </main>

            <aside className="detail-properties-rail">
              {d.sessions[0] && <ResumeBlock s={d.sessions[0]} />}
              <Properties d={d} />
              <Relationships d={d} lineage={kin?.lineage} onSelectTask={onSelectTask} />
            </aside>
          </div>
        </div>
      )}
    </NawabanDialog>
  );
}
