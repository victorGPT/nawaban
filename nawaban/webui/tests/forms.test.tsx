import { useState } from "react";
import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input, InputBase } from "@/components/base/input/input";
import { Textarea } from "@/components/base/textarea/textarea";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { RadioGroup, Radio } from "@/components/base/radio/radio";
import { RadioCard } from "@/components/base/radio/radio-card";
import { Switch } from "@/components/base/switch/switch";
import { Tabs, TabList, Tab, TabPanel } from "@/components/base/tabs/tabs";

function Fields() {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  return <><Input label="Name" hint="Use a full name" value={name} onChange={setName} isRequired />
    <Textarea id="description-control" label="Description" hint="Explain the issue" value={body} onChange={setBody} showCount maxLength={20} />
    <Input label="Read only" value="Fixed" isReadOnly />
    <Input label="Invalid" hint="Required field" isInvalid />
    <Input label="Disabled" isDisabled />
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
  expect(screen.getByText("13/20")).toBeTruthy();
  const fixed = screen.getByRole("textbox", { name: "Read only" }) as HTMLInputElement;
  await user.type(fixed, "change");
  expect(fixed.value).toBe("Fixed");
  expect(screen.getByRole("textbox", { name: "Invalid" }).getAttribute("aria-invalid")).toBe("true");
  expect((screen.getByRole("textbox", { name: "Disabled" }) as HTMLInputElement).disabled).toBe(true);
});

test("standalone InputBase keeps native change events and textarea supports uncontrolled input", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<><InputBase aria-label="Search" onChange={(event) => change(event.target.value)} />
    <Textarea label="Draft" defaultValue="A" showCount /></>);
  await user.type(screen.getByRole("textbox", { name: "Search" }), "ab");
  expect(change.mock.calls).toEqual([["a"], ["ab"]]);
  await user.type(screen.getByRole("textbox", { name: "Draft" }), "B");
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("AB");
  expect(screen.getByText("2")).toBeTruthy();
});

function Choices({ checkboxChange, switchChange }: { checkboxChange: (value: boolean) => void; switchChange: (value: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  const [on, setOn] = useState(false);
  return <><Checkbox isSelected={checked} onChange={(value) => { setChecked(value); checkboxChange(value); }}>Accept</Checkbox>
    <Checkbox isIndeterminate aria-label="Partial" />
    <Checkbox isReadOnly isSelected>Locked</Checkbox>
    <Checkbox isDisabled>Unavailable</Checkbox>
    <Switch isSelected={on} onChange={(value) => { setOn(value); switchChange(value); }}>Focus mode</Switch></>;
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
  return <RadioGroup aria-label="Decision" value={value} onChange={setValue}>
    <Radio value="a">First</Radio><Radio value="b" isDisabled>Unavailable</Radio>
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

test("tabs associate their panels and automatically activate on keyboard navigation", async () => {
  const user = userEvent.setup();
  render(<Tabs defaultSelectedKey="one"><TabList aria-label="Sections">
    <Tab id="one">One</Tab><Tab id="disabled" isDisabled>Disabled</Tab><Tab id="two" count={2}>Two</Tab>
  </TabList><TabPanel id="one">First panel</TabPanel><TabPanel id="two">Second panel</TabPanel></Tabs>);
  const first = screen.getByRole("tab", { name: "One" });
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(document.getElementById(first.getAttribute("aria-controls")!)?.textContent).toBe("First panel");
  await user.tab();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Disabled" }).getAttribute("aria-selected")).toBe("false");
  await user.keyboard("{ArrowRight}");
  const second = screen.getByRole("tab", { name: /Two.*2/ });
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").textContent).toBe("Second panel");
});
