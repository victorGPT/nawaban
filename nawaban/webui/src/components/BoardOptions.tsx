import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { RiFilter3Line, RiEqualizerLine } from "@remixicon/react";
import { t as tr, waitingLabel } from "@/i18n";
import { Button, buttonStyles } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Select, SelectItem } from "@/components/base/select/select";
import { ModuleSelect } from "@/components/base/select/module-select";
import { MENU_POPOVER_SURFACE } from "@/components/base/dropdown/menu-styles";
import { BOARD_COLUMNS } from "@/lib/nawaban-model";
import { UNGROUPED_EPIC } from "@/lib/modules-model";
import { SORT_OPTIONS, DISPLAY_FIELDS, type BoardDisplay } from "@/lib/board-display";
import { cx } from "@/utils/cx";

function OptionsPanel({ label, icon: Icon, active, children }: {
  label: string;
  icon: typeof RiFilter3Line;
  active?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className={cx(buttonStyles.base, buttonStyles.size.small,
      buttonStyles.variant.secondary, active && "board-tool-active")}>
      <Icon className={buttonStyles.icon.small} aria-hidden />{label}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={8} align="end" className="bui-popup-layer">
        <Popover.Popup aria-label={label} className={cx(MENU_POPOVER_SURFACE,
          "board-options-panel flex flex-col gap-4 p-4")}>
          <Popover.Title className="text-body-medium">{label}</Popover.Title>
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

export function BoardOptions({ modules, module, onModuleChange, waiting, onWaitingChange,
  dateFilters, dateActive, display, onDisplayChange }: {
  modules: string[];
  module: string;
  onModuleChange: (value: string) => void;
  waiting: string;
  onWaitingChange: (value: string) => void;
  dateFilters?: ReactNode;
  dateActive: boolean;
  display: BoardDisplay;
  onDisplayChange: (display: BoardDisplay) => void;
}) {
  const toggle = (key: "columns" | "fields", id: string, checked: boolean) =>
    onDisplayChange({ ...display, [key]: checked ? [...display[key], id] : display[key].filter((value) => value !== id) });
  return <>
    <OptionsPanel label={tr("boardFilter")} icon={RiFilter3Line}
      active={module !== "all" || !!waiting || dateActive}>
      <div className="flex flex-col gap-2">
        <span className="text-body-2-medium text-text-secondary">{tr("epicName")}</span>
        <ModuleSelect modules={modules} value={module} onValueChange={onModuleChange}
          getLabel={(value) => value === UNGROUPED_EPIC ? tr("ungrouped") : value} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-body-2-medium text-text-secondary">{tr("filterWaiting")}</span>
        <Select size="sm" aria-label={tr("filterWaiting")} selectedKey={waiting}
          onSelectionChange={(key) => onWaitingChange(String(key))}>
          {["", "decision", "prod", "observe", "external"].map((value) =>
            <SelectItem key={value} id={value}>{value ? waitingLabel(value) : tr("allWaiting")}</SelectItem>)}
        </Select>
      </div>
      {dateFilters}
    </OptionsPanel>
    <OptionsPanel label={tr("boardDisplay")} icon={RiEqualizerLine}>
      <div className="flex flex-col gap-2">
        <span className="text-body-2-medium text-text-secondary">{tr("boardSort")}</span>
        <Select size="sm" aria-label={tr("boardSort")} selectedKey={display.sort}
          onSelectionChange={(key) => onDisplayChange({ ...display, sort: key as BoardDisplay["sort"] })}>
          {SORT_OPTIONS.map((sort) => <SelectItem key={sort} id={sort}>{tr(`boardSort_${sort}`)}</SelectItem>)}
        </Select>
      </div>
      <Checkbox isSelected={display.compact}
        onChange={(compact) => onDisplayChange({ ...display, compact })}>{tr("boardCompact")}</Checkbox>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body-2-medium text-text-secondary">{tr("boardFields")}</legend>
        {DISPLAY_FIELDS.map((field) => <Checkbox key={field} isSelected={display.fields.includes(field)}
          onChange={(checked) => toggle("fields", field, checked)}>{tr(field === "id" ? "taskId" : "epicName")}</Checkbox>)}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body-2-medium text-text-secondary">{tr("boardColumns")}</legend>
        {BOARD_COLUMNS.map((column) => <Checkbox key={column.id} isSelected={display.columns.includes(column.id)}
          onChange={(checked) => toggle("columns", column.id, checked)}>{column.label}</Checkbox>)}
      </fieldset>
      <p className="text-caption-1-regular text-text-tertiary">{tr("boardColumnsHint")}</p>
      <Button variant="ghost" size="small" disabled={display.columns.length === BOARD_COLUMNS.length}
        onClick={() => onDisplayChange({ ...display,
        columns: BOARD_COLUMNS.map((column) => column.id) })}>{tr("boardShowAllColumns")}</Button>
    </OptionsPanel>
  </>;
}
