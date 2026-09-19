import type { ComponentProps } from "react";
import { TableRow } from "@/components/ui/table";

/**
 * App composition: a shadcn table row that behaves like a link — Enter/Space
 * activate it, arrows/Home/End move between rows, and nested controls keep
 * their own actions. shadcn's Table has no interactive-row variant.
 */
export function ActionRow({ onAction, ...props }: ComponentProps<typeof TableRow> & { onAction: () => void }) {
  return <TableRow {...props} tabIndex={0} data-row-action="" onClick={(event) => {
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
