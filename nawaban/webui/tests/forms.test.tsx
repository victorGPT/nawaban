import { useState } from "react";
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RadioCard } from "@/components/application/radio/radio-card";
import { Switch } from "@/components/ui/switch";

function Fields() {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  return <>
    <Label htmlFor="name-control">Name</Label>
    <Input id="name-control" aria-describedby="name-hint" required value={name}
      onChange={(event) => setName(event.target.value)} />
    <p id="name-hint">Use a full name</p>
    <Label htmlFor="description-control">Description</Label>
    <Textarea id="description-control" aria-describedby="description-hint" value={body}
      onChange={(event) => setBody(event.target.value)} maxLength={20} />
    <p id="description-hint">Explain the issue</p>
    <Label htmlFor="readonly-control">Read only</Label>
    <Input id="readonly-control" value="Fixed" readOnly onChange={() => {}} />
    <Label htmlFor="invalid-control">Invalid</Label>
    <Input id="invalid-control" aria-invalid />
    <Label htmlFor="disabled-control">Disabled</Label>
    <Input id="disabled-control" disabled />
  </>;
}
test("fields associate labels and hints, edit controlled values, and expose readonly/invalid/disabled states", async () => {
  const user = userEvent.setup();
  render(<Fields />);
  const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  expect(input.required).toBe(true);
  expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("Use a full name");
  await user.click(screen.getByText("Name"));
  expect(document.activeElement).toBe(input);
  await user.type(input, "Ada");
  expect(input.value).toBe("Ada");
  const textarea = screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
  expect(textarea.tagName).toBe("TEXTAREA");
  expect(textarea.id).toBe("description-control");
  await user.click(screen.getByText("Description"));
  expect(document.activeElement).toBe(textarea);
  expect(document.getElementById(textarea.getAttribute("aria-describedby")!)?.textContent).toBe("Explain the issue");
  await user.type(textarea, "Line 1{Enter}Line 2");
  expect(textarea.value).toBe("Line 1\nLine 2");
  const fixed = screen.getByRole("textbox", { name: "Read only" }) as HTMLInputElement;
  await user.type(fixed, "change");
  expect(fixed.value).toBe("Fixed");
  expect(screen.getByRole("textbox", { name: "Invalid" }).getAttribute("aria-invalid")).toBe("true");
  expect((screen.getByRole("textbox", { name: "Disabled" }) as HTMLInputElement).disabled).toBe(true);
});

test("input keeps native change events and textarea supports uncontrolled input", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<><Input aria-label="Search" onChange={(event) => change(event.target.value)} />
    <Label htmlFor="draft-control">Draft</Label>
    <Textarea id="draft-control" defaultValue="A" /></>);
  await user.type(screen.getByRole("textbox", { name: "Search" }), "ab");
  expect(change.mock.calls).toEqual([["a"], ["ab"]]);
  await user.type(screen.getByRole("textbox", { name: "Draft" }), "B");
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("AB");
});

function Choices({ checkboxChange, switchChange }: { checkboxChange: (value: boolean) => void; switchChange: (value: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  const [on, setOn] = useState(false);
  return <>
    <Checkbox id="accept" checked={checked}
      onCheckedChange={(value) => { setChecked(value === true); checkboxChange(value === true); }} />
    <Label htmlFor="accept">Accept</Label>
    <Checkbox indeterminate aria-label="Partial" />
    <Checkbox id="locked" readOnly checked />
    <Label htmlFor="locked">Locked</Label>
    <Checkbox id="unavailable" disabled />
    <Label htmlFor="unavailable">Unavailable</Label>
    <Switch id="focus-mode" checked={on}
      onCheckedChange={(value) => { setOn(value); switchChange(value); }} />
    <Label htmlFor="focus-mode">Focus mode</Label>
  </>;
}
test("checkbox and switch labels activate once, Space toggles, and mixed/readonly/disabled state is preserved", async () => {
  const user = userEvent.setup();
  const checkboxChange = vi.fn(), switchChange = vi.fn();
  render(<Choices checkboxChange={checkboxChange} switchChange={switchChange} />);
  const checkbox = screen.getByRole("checkbox", { name: "Accept" });
  await user.click(screen.getByText("Accept"));
  expect(checkboxChange.mock.calls).toEqual([[true]]);
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  await user.keyboard(" ");
  expect(checkboxChange.mock.calls).toEqual([[true], [false]]);
  expect(screen.getByRole("checkbox", { name: "Partial" }).getAttribute("aria-checked")).toBe("mixed");
  await user.click(screen.getByRole("checkbox", { name: "Locked" }));
  expect(screen.getByRole("checkbox", { name: "Locked" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("checkbox", { name: "Unavailable" }).getAttribute("aria-disabled")).toBe("true");
  const toggle = screen.getByRole("switch", { name: "Focus mode" });
  await user.click(toggle);
  expect(switchChange.mock.calls).toEqual([[true]]);
  await user.keyboard(" ");
  expect(switchChange.mock.calls).toEqual([[true], [false]]);
});

function Radios() {
  const [value, setValue] = useState("a");
  return <RadioGroup aria-label="Decision" value={value} onValueChange={(next) => setValue(String(next))}>
    <label className="group/field-label"><RadioGroupItem value="a" />First</label>
    <label className="group/field-label"><RadioGroupItem value="b" disabled />Unavailable</label>
    <RadioCard value="c" title="Third" description="Use this option" />
  </RadioGroup>;
}
test("radio group arrows skip disabled items and card labels select with one tab stop", async () => {
  const user = userEvent.setup();
  render(<Radios />);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "First" }));
  await user.keyboard("{ArrowDown}");
  const third = screen.getByRole("radio", { name: /Third.*Use this option/ });
  expect(document.activeElement).toBe(third);
  expect(third.getAttribute("aria-checked")).toBe("true");
  await user.click(screen.getByText("First"));
  expect(screen.getByRole("radio", { name: "First" }).getAttribute("aria-checked")).toBe("true");
});
