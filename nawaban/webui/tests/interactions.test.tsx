import { useState } from "react";
import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import { NawabanDialog, Notices, useNotice } from "@/components/NawabanUI";
import { Table, TableBody, TableCell } from "@/components/ui/table";
import { ActionRow } from "@/components/application/table/action-row";

function DialogExample() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Open task</Button>
    <NawabanDialog open={open} onClose={() => setOpen(false)} title="Task details">
      <Button>Last action</Button>
    </NawabanDialog></>;
}
test("dialog Escape dismisses, traps focus, and restores its opener", async () => {
  const user = userEvent.setup();
  render(<DialogExample />);
  const opener = screen.getByRole("button", { name: "Open task" });
  await user.click(opener);
  expect(screen.getByRole("dialog", { name: "Task details" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "\u5173\u95ed" })));
  await user.tab({ shift: true });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last action" })));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
test("rows support keyboard traversal/activation without swallowing nested decisions", async () => {
  const user = userEvent.setup();
  const open = vi.fn(), decide = vi.fn();
  render(<Table aria-label="Tasks"><TableBody>
    <ActionRow aria-label="First" onAction={() => open("first")}><TableCell>First</TableCell></ActionRow>
    <ActionRow aria-label="Second" onAction={() => open("second")}><TableCell><Button onClick={decide}>Decide</Button></TableCell></ActionRow>
  </TableBody></Table>);
  await user.tab();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(open).toHaveBeenLastCalledWith("second");
  await user.keyboard("{Home} ");
  expect(open).toHaveBeenLastCalledWith("first");
  await user.click(screen.getByRole("button", { name: "Decide" }));
  expect(decide).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(2);
});
function NoticeExample() {
  const notify = useNotice();
  return <Button onClick={() => notify("Saved", "success", "Task saved")}>Notify</Button>;
}
test("notices render their message and dismiss through the shadcn toast", async () => {
  const user = userEvent.setup();
  render(<Notices><NoticeExample /></Notices>);
  await user.click(screen.getByRole("button", { name: "Notify" }));
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.getByText("Task saved")).toBeTruthy();
  await user.hover(screen.getByText("Saved"));
  await user.click(await screen.findByRole("button", { name: "\u5173\u95ed\u901a\u77e5" }));
  await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
});
