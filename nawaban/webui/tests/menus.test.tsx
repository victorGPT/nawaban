import { useState } from "react";
import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleSelect } from "@/components/application/select/module-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OverflowText } from "@/components/OverflowText";
import { Button } from "@/components/ui/button";
import { NawabanDialog } from "@/components/NawabanUI";

const PROVIDERS = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma" },
];

function Options({ changed, disabled = false }: { changed: (value: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("alpha");
  return <Select items={PROVIDERS} value={value} disabled={disabled} onValueChange={(key) => {
    setValue(String(key));
    changed(String(key));
  }}>
    <SelectTrigger aria-label="Provider"><SelectValue /></SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false}>
      {PROVIDERS.map((provider) => (
        <SelectItem key={provider.value} value={provider.value} disabled={provider.value === "beta"}>
          {provider.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>;
}

test("select keyboard navigation cannot activate disabled options and commits only on activation", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<Options changed={changed} />);
  const trigger = screen.getByRole("combobox", { name: "Provider" });
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Alpha" })));
  expect(screen.getByRole("option", { name: "Beta" }).getAttribute("aria-disabled")).toBe("true");
  await user.keyboard("{Home}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Alpha" })));
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Beta" })));
  await user.keyboard("{Enter}");
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeTruthy();
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Gamma" })));
  expect(changed).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith("gamma"));
  expect(trigger.textContent).toContain("Gamma");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("disabled select cannot open or change through pointer or keyboard", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<><Options disabled changed={changed} /><Button>Next</Button></>);
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
  await user.keyboard("{ArrowDown}{Enter}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

test("tooltip keeps its trigger label, opens on hover and focus, and closes with Escape", async () => {
  const user = userEvent.setup();
  render(<Tooltip>
    <TooltipTrigger render={<Button aria-label="Helpful details">Help</Button>} />
    <TooltipContent>Helpful details</TooltipContent>
  </Tooltip>);
  const trigger = screen.getByRole("button", { name: "Helpful details" });
  await user.hover(trigger);
  const tooltip = await screen.findByText("Helpful details");
  expect(tooltip.textContent).toBe("Helpful details");
  expect(trigger.getAttribute("aria-label")).toBe(tooltip.textContent);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByText("Helpful details")).toBeNull());
  await user.unhover(trigger);
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  expect(await screen.findByText("Helpful details")).toBeTruthy();
});

test("managed overflow opens only for clipped text and adds no nested interactive or tab stop", async () => {
  const user = userEvent.setup();
  render(<><Button><OverflowText text="Task title" /></Button><Button>Next action</Button></>);
  const text = screen.getByText("Task title");
  Object.defineProperties(text, { clientWidth: { value: 100, configurable: true }, scrollWidth: { value: 100, configurable: true } });
  await user.hover(text);
  expect(screen.getAllByText("Task title")).toHaveLength(1);
  await user.unhover(text);
  Object.defineProperty(text, "scrollWidth", { value: 200, configurable: true });
  await user.hover(text);
  await waitFor(() => expect(screen.getAllByText("Task title")).toHaveLength(2));
  expect(text.tagName).toBe("SPAN");
  expect(text.getAttribute("role")).toBeNull();
  expect(text.getAttribute("tabindex")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(2);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.getAllByText("Task title")).toHaveLength(1));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Task title" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next action" }));
});

function NestedSelect({ close }: { close: () => void }) {
  return <NawabanDialog open onClose={close} title="Settings"><Options changed={() => {}} /></NawabanDialog>;
}
test("Escape closes a nested select before the owning dialog", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<NestedSelect close={close} />);
  const trigger = screen.getByRole("combobox", { name: "Provider" });
  await user.click(trigger);
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
});

test("project switcher offers all projects first and commits the chosen project", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<ModuleSelect modules={["example-project", "nawaban"]} value="all" onValueChange={changed}
    allLabel={"全部项目"} ariaLabel={"切换项目"} />);
  const trigger = screen.getByRole("combobox", { name: "切换项目" });
  expect(trigger.textContent).toContain("全部项目");
  await user.click(trigger);
  await screen.findByRole("listbox");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["全部项目", "example-project", "nawaban"]);
  await user.click(screen.getByRole("option", { name: "nawaban" }));
  expect(changed).toHaveBeenCalledWith("nawaban");
});
