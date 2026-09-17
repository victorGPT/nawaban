"use client";

import { createContext, Fragment, useContext } from "react";
import type { ComponentType, ReactNode, Ref } from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cx } from "@/utils/cx";

/** BoardUI underline tabs with Base UI keyboard navigation and panel association. */
type TabKey = string | number;
type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
const TabsContext = createContext({ keyboardActivation: "automatic" as "automatic" | "manual", disabledKeys: new Set<TabKey>(), isDisabled: false });

export interface TabsProps extends Omit<BaseTabs.Root.Props, "value" | "defaultValue" | "onValueChange"> {
  ref?: Ref<HTMLDivElement>;
  selectedKey?: TabKey | null;
  defaultSelectedKey?: TabKey;
  onSelectionChange?: (key: TabKey) => void;
  keyboardActivation?: "automatic" | "manual";
  disabledKeys?: Iterable<TabKey>;
  isDisabled?: boolean;
}

export function Tabs({ className, ref, selectedKey, defaultSelectedKey, onSelectionChange,
  keyboardActivation = "automatic", disabledKeys, isDisabled = false, ...props }: TabsProps) {
  return <TabsContext.Provider value={{ keyboardActivation, disabledKeys: new Set(disabledKeys), isDisabled }}>
    <BaseTabs.Root {...props} ref={ref} value={selectedKey} defaultValue={defaultSelectedKey}
      onValueChange={(value: TabKey | null) => { if (value !== null) onSelectionChange?.(value); }}
      className={(state) => cx("flex w-full flex-col gap-4", state.orientation === "vertical" && "flex-row",
        typeof className === "function" ? className(state) : className)} />
  </TabsContext.Provider>;
}

export interface TabListProps<T extends object> extends Omit<BaseTabs.List.Props, "children"> {
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode | ((item: T) => ReactNode);
  items?: Iterable<T>;
}

export function TabList<T extends object>({ className, ref, items, children, ...props }: TabListProps<T>) {
  const ctx = useContext(TabsContext);
  return <BaseTabs.List {...props} ref={ref} activateOnFocus={ctx.keyboardActivation === "automatic"}
    className={(state) => cx("relative flex w-full items-center gap-1 border-b border-separator-border",
      state.orientation === "vertical" && "w-auto flex-col items-stretch border-b-0 border-r",
      typeof className === "function" ? className(state) : className)}>
    {typeof children === "function" ? Array.from(items ?? [], (item, index) => <Fragment key={index}>{children(item)}</Fragment>) : children}
    <BaseTabs.Indicator className={cx(
      "pointer-events-none absolute left-0 top-0 bg-accent-600 transition-[translate,width,height] duration-200 ease",
      "data-[orientation=horizontal]:h-0.5 data-[orientation=horizontal]:w-[var(--active-tab-width)] data-[orientation=horizontal]:translate-x-[var(--active-tab-left)] data-[orientation=horizontal]:translate-y-[calc(var(--active-tab-top)+var(--active-tab-height)-2px)]",
      "data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:h-[var(--active-tab-height)] data-[orientation=vertical]:translate-y-[var(--active-tab-top)] data-[orientation=vertical]:translate-x-[calc(var(--active-tab-left)+var(--active-tab-width)-2px)]",
    )} />
  </BaseTabs.List>;
}

interface TabState { isSelected: boolean; isDisabled: boolean }
export interface TabProps extends Omit<BaseTabs.Tab.Props, "children" | "className" | "value" | "id" | "ref"> {
  id: TabKey;
  children?: ReactNode;
  className?: string | ((state: TabState) => string);
  icon?: IconComponent;
  count?: ReactNode;
  isDisabled?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function Tab({ id, className, children, icon: Icon, count, ref, isDisabled, ...props }: TabProps) {
  const ctx = useContext(TabsContext);
  return <BaseTabs.Tab {...props} ref={ref} value={id} nativeButton={false}
    disabled={isDisabled || props.disabled || ctx.isDisabled || ctx.disabledKeys.has(id)}
    render={(rootProps, state) => <div {...rootProps} data-selected={state.active ? "" : undefined}
      className={cx(rootProps.className, "relative inline-flex cursor-pointer items-center gap-2.5 px-2.5 py-2 whitespace-nowrap",
        "outline-none transition-colors duration-150 ease",
        "focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        state.disabled && "cursor-not-allowed opacity-50",
        typeof className === "function" ? className({ isSelected: state.active, isDisabled: state.disabled }) : className)}>
      <span className={cx("inline-flex items-center gap-1.5", state.active ? "text-body-medium text-accent-600" : "text-body-regular text-text-primary")}>
        {Icon && <Icon className="size-4 shrink-0" aria-hidden />}{children}
      </span>
      {count != null && <span className={cx("inline-flex items-center justify-center rounded-sm px-1 py-px text-caption-1-medium whitespace-nowrap",
        state.active ? "bg-tab-count-selected-background text-accent-600" : "bg-black/10 text-text-primary opacity-50")}>{count}</span>}
    </div>} />;
}

export interface TabPanelProps extends Omit<BaseTabs.Panel.Props, "value" | "id"> {
  id: TabKey;
  shouldForceMount?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function TabPanel({ id, className, ref, shouldForceMount, ...props }: TabPanelProps) {
  return <BaseTabs.Panel {...props} ref={ref} value={id} keepMounted={shouldForceMount ?? props.keepMounted}
    className={(state) => cx("outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-border-focus-ring",
      state.hidden && "hidden", typeof className === "function" ? className(state) : className)} />;
}
