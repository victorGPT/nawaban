import { t as tr, useLocale } from "@/i18n";
import { UNGROUPED_EPIC } from "@/lib/modules-model";
import { TASK_REFRESH_MS } from "@/lib/poll-read-only";
import type { Project } from "@/lib/types";

export function BoardSourceLine({
  project,
  module,
  count,
  error,
  refreshing,
  updatedAt,
}: {
  project: Project;
  module: string;
  /** Visible task count; null until the first board arrives. */
  count: number | null;
  error: string;
  refreshing: boolean;
  updatedAt: Date | null;
}) {
  const locale = useLocale();
  return (
    <div className="board-source-line text-caption-1-regular">
      <span className="board-source-scope" role="status">
        {project === null ? tr("allProjects") : project || tr("noProject")} / {module === "all" ? tr("allEpics") : module === UNGROUPED_EPIC ? tr("ungrouped") : module}
        {" · "}{count !== null ? tr("taskCount", { count }) : error && !refreshing ? tr("boardSyncFailed") : tr("loadingTasks")}
      </span>
      <span className="board-sync-time">
        {refreshing ? tr("syncingTasks") : error ? tr("boardSyncFailed") : updatedAt && tr("syncedAt", { time: updatedAt.toLocaleTimeString(locale, { hour12: false }) })}
        {" · "}{tr("refreshEvery", { seconds: TASK_REFRESH_MS / 1000 })}
      </span>
    </div>
  );
}
