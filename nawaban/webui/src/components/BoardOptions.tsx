import { type ReactNode } from "react";
import { RiFilter3Line, RiEqualizerLine } from "@remixicon/react";
import { t as tr, waitingLabel } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleSelect } from "@/components/application/select/module-select";
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
  return <Popover>
    <PopoverTrigger render={<Button variant="outline" className={cx(active && "board-tool-active")} />}>
      <Icon aria-hidden="true" />{label}
    </PopoverTrigger>
    <PopoverContent sideOffset={8} align="end" aria-label={label}
      className="board-options-panel flex flex-col gap-4 p-4">
      <PopoverTitle className="text-body-medium">{label}</PopoverTitle>
      {children}
    </PopoverContent>
  </Popover>;
}

/** Label + control row, matching the spacing the hand-built Select used. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-2">
    <span className="text-body-2-medium text-text-secondary">{label}</span>
    {children}
  </div>;
}

/** shadcn checkboxes are unlabelled controls; the kit's Checkbox took children. */
function CheckboxField({ checked, onCheckedChange, children }: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return <label className="group/field-label flex cursor-pointer items-center gap-2 text-body-medium text-text-primary">
    <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
    {children}
  </label>;
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
  const waitingValues = ["", "decision", "prod", "observe", "external"];
  return <>
    <OptionsPanel label={tr("boardFilter")} icon={RiFilter3Line}
      active={module !== "all" || !!waiting || dateActive}>
      <Field label={tr("epicName")}>
        <ModuleSelect modules={modules} value={module} onValueChange={onModuleChange}
          getLabel={(value) => value === UNGROUPED_EPIC ? tr("ungrouped") : value} />
      </Field>
      <Field label={tr("filterWaiting")}>
        <Select
          items={waitingValues.map((value) => ({ value, label: value ? waitingLabel(value) : tr("allWaiting") }))}
          value={waiting}
          onValueChange={(value) => onWaitingChange(String(value))}
        >
          <SelectTrigger size="sm" aria-label={tr("filterWaiting")} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {waitingValues.map((value) =>
              <SelectItem key={value} value={value}>{value ? waitingLabel(value) : tr("allWaiting")}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {dateFilters}
    </OptionsPanel>
    <OptionsPanel label={tr("boardDisplay")} icon={RiEqualizerLine}>
      <Field label={tr("boardSort")}>
        <Select
          items={SORT_OPTIONS.map((sort) => ({ value: sort, label: tr(`boardSort_${sort}`) }))}
          value={display.sort}
          onValueChange={(value) => onDisplayChange({ ...display, sort: value as BoardDisplay["sort"] })}
        >
          <SelectTrigger size="sm" aria-label={tr("boardSort")} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {SORT_OPTIONS.map((sort) => <SelectItem key={sort} value={sort}>{tr(`boardSort_${sort}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <CheckboxField checked={display.compact}
        onCheckedChange={(compact) => onDisplayChange({ ...display, compact })}>{tr("boardCompact")}</CheckboxField>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body-2-medium text-text-secondary">{tr("boardFields")}</legend>
        {DISPLAY_FIELDS.map((field) => <CheckboxField key={field} checked={display.fields.includes(field)}
          onCheckedChange={(checked) => toggle("fields", field, checked)}>{tr(field === "id" ? "taskId" : "epicName")}</CheckboxField>)}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body-2-medium text-text-secondary">{tr("boardColumns")}</legend>
        {BOARD_COLUMNS.map((column) => <CheckboxField key={column.id} checked={display.columns.includes(column.id)}
          onCheckedChange={(checked) => toggle("columns", column.id, checked)}>{column.label}</CheckboxField>)}
      </fieldset>
      <p className="text-caption-1-regular text-text-tertiary">{tr("boardColumnsHint")}</p>
      <Button variant="soft" disabled={display.columns.length === BOARD_COLUMNS.length}
        onClick={() => onDisplayChange({ ...display,
        columns: BOARD_COLUMNS.map((column) => column.id) })}>{tr("boardShowAllColumns")}</Button>
    </OptionsPanel>
  </>;
}
