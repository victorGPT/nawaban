"use client";

import type { ComponentProps, ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { MENU_ITEM, MENU_ITEM_ACTIVE, MENU_ITEM_INTERACTIVE, MENU_POPOVER_SURFACE, MENU_POPOVER_WIDTH } from "@/components/base/dropdown/menu-styles";
import { cx } from "@/utils/cx";

/** BoardUI action menus with Base UI keyboard navigation and dismissal. */
export interface DropdownProps {
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  children: ReactNode;
}

export function Dropdown({ isOpen, onOpenChange, children }: DropdownProps) {
  return <Menu.Root open={isOpen} onOpenChange={onOpenChange} modal={false}>{children}</Menu.Root>;
}

export function DropdownTrigger({ className, ...props }: ComponentProps<typeof Menu.Trigger>) {
  return <Menu.Trigger {...props} className={(state) => cx("cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring", typeof className === "function" ? className(state) : className)} />;
}

type Placement = "top" | "bottom" | "left" | "right" | "top start" | "top end" | "bottom start" | "bottom end" | "right top" | "right bottom" | "left top" | "left bottom";
export interface DropdownPopoverProps {
  placement?: Placement;
  offset?: number;
  crossOffset?: number;
  "aria-label": string;
  className?: string;
  dialogClassName?: string;
  children: ReactNode;
}

export function DropdownPopover({ "aria-label": ariaLabel, placement = "bottom start", offset = 4, crossOffset, className, dialogClassName, children }: DropdownPopoverProps) {
  const [side, edge] = placement.split(" ") as ["top" | "bottom" | "left" | "right", string | undefined];
  const align = edge === "start" || edge === "top" ? "start" : edge === "end" || edge === "bottom" ? "end" : "center";
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={offset} alignOffset={crossOffset} className="bui-popup-layer">
        <Menu.Popup aria-label={ariaLabel} className={cx(MENU_POPOVER_WIDTH, MENU_POPOVER_SURFACE, className)}>
          <div className={cx("flex flex-col gap-1 outline-none", dialogClassName)}>{children}</div>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export interface DropdownGroupProps { label?: string; className?: string; children: ReactNode }
export function DropdownGroup({ label, className, children }: DropdownGroupProps) {
  return <Menu.Group className={cx("flex w-full flex-col gap-1.5", label && "pt-1", className)}>
    {label && <Menu.GroupLabel className="pl-2 text-body-medium text-text-secondary">{label}</Menu.GroupLabel>}
    <div className="flex w-full flex-col gap-1">{children}</div>
  </Menu.Group>;
}

export interface DropdownItemProps {
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
  children: ReactNode;
}
export function DropdownItem({ selected, onSelect, className, children }: DropdownItemProps) {
  return <Menu.Item onClick={onSelect} aria-current={selected ? "true" : undefined} className={(state) => cx(MENU_ITEM, selected || state.highlighted ? MENU_ITEM_ACTIVE : MENU_ITEM_INTERACTIVE, className)}>{children}</Menu.Item>;
}
export function DropdownDivider({ className }: { className?: string }) {
  return <Menu.Separator className={cx("-mx-2.5 my-1.5 h-px shrink-0 bg-border-button-default", className)} />;
}
