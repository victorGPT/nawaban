import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/utils/cx";

// Native table semantics remain available to screen readers. Actionable rows
// add keyboard activation; nested controls keep their independent actions.
export interface TableProps extends ComponentProps<"table"> {
  size?: "sm" | "md";
  containerClassName?: string;
}
export function Table({ size = "md", className, containerClassName, ...props }: TableProps) {
  return <div className={cx("w-full overflow-x-auto", containerClassName)}>
    <table {...props} className={cx("bui-table", size === "sm" && "bui-table-sm", className)} />
  </div>;
}
export function TableHeader({ children, ...props }: ComponentProps<"thead">) {
  return <thead {...props}><tr>{children}</tr></thead>;
}
export function TableColumn(props: ComponentProps<"th">) {
  return <th scope="col" {...props} />;
}
export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}
export function TableCell(props: ComponentProps<"td">) {
  return <td {...props} />;
}
export function TableEmpty({ children, colSpan }: { children: ReactNode; colSpan: number }) {
  return <tr><td colSpan={colSpan}>{children}</td></tr>;
}
export function TableRow({ onAction, ...props }: ComponentProps<"tr"> & { onAction: () => void }) {
  return <tr {...props} tabIndex={0} data-row-action="" onClick={(event) => {
    props.onClick?.(event);
    if (event.defaultPrevented || (event.target as HTMLElement).closest("button,a,input,select,textarea,[role=button]")) return;
    onAction();
  }} onKeyDown={(event) => {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onAction();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const rows = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLTableRowElement>("tr[data-row-action]"));
      const index = rows.indexOf(event.currentTarget);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      rows[next].focus();
    }
  }} />;
}
