import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/base/buttons/button";
import { NawabanDialog, Notices, useNotice } from "@/components/NawabanUI";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { RadioGroup, Radio } from "@/components/base/radio/radio";
import { Textarea } from "@/components/base/textarea/textarea";
import { Tabs, TabList, Tab, TabPanel } from "@/components/base/tabs/tabs";
import "@/index.css";

// Isolated component fixture: no NAWABAN API calls or persisted business data.
function Fixture() {
  const [open, setOpen] = useState(false);
  const notice = useNotice();
  return <main className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
    <h1 className="text-title-1-medium">Interaction verification</h1>
    <Button onClick={() => setOpen(true)}>Dialog</Button>
    <Button onClick={() => notice("保存成功", "success", "独立交互测试")}>Notification</Button>
    <Checkbox>Checkbox</Checkbox>
    <RadioGroup aria-label="Decision" defaultValue="first"><Radio value="first">First</Radio><Radio value="second">Second</Radio></RadioGroup>
    <Textarea label="Notes" placeholder="Enter a note" />
    <Tabs defaultSelectedKey="first"><TabList aria-label="Sections"><Tab id="first">Overview</Tab><Tab id="second">Details</Tab></TabList><TabPanel id="first">Overview panel</TabPanel><TabPanel id="second">Details panel</TabPanel></Tabs>
    <NawabanDialog open={open} onClose={() => setOpen(false)} title="Interaction dialog">
      <Button onClick={() => setOpen(false)}>Close dialog</Button>
    </NawabanDialog>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Notices><Fixture /></Notices>);
