import { t as tr, useLocale } from "@/i18n";
import type { ReactNode } from "react";
import { RiLayoutColumnLine, RiListCheck, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";

export function BoardToolbar({
  layout,
  onLayoutChange,
  refreshing,
  onRefresh,
  children,
}: {
  layout: string;
  onLayoutChange: (layout: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  useLocale();
  return (
    <div className="board-toolbar">
      <div className="view-toggle">
        <Button
          variant={layout === "board" ? "outline" : "ghost"}
          className={
            layout !== "board"
              ? "bg-transparent text-text-secondary"
              : undefined
          }
          aria-pressed={layout === "board"}
          onClick={() => onLayoutChange("board")}
        ><RiLayoutColumnLine aria-hidden="true" />{tr("board")}</Button>
        <Button
          variant={layout === "list" ? "outline" : "ghost"}
          className={
            layout !== "list"
              ? "bg-transparent text-text-secondary"
              : undefined
          }
          aria-pressed={layout === "list"}
          onClick={() => onLayoutChange("list")}
        ><RiListCheck aria-hidden="true" />{tr("list")}</Button>
      </div>
      <Button variant="outline" size="icon"
        aria-label={tr("refreshTasks")} title={tr("refreshTasks")}
        disabled={refreshing} onClick={onRefresh}>
        <RiRefreshLine aria-hidden="true" />
      </Button>
      {children}
    </div>
  );
}
