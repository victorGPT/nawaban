import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { NawabanDialog, Notices, useNotice } from "@/components/NawabanUI";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import "@/index.css";

// Isolated component fixture: no NAWABAN API calls or persisted business data.
function Fixture() {
  const [open, setOpen] = useState(false);
  const notice = useNotice();
  return <main className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
    <h1 className="text-title-1-medium">Interaction verification</h1>
    <Button onClick={() => setOpen(true)}>Dialog</Button>
    <Button onClick={() => notice("\u4fdd\u5b58\u6210\u529f", "success", "\u72ec\u7acb\u4ea4\u4e92\u6d4b\u8bd5")}>Notification</Button>
    <label className="group/field-label flex items-center gap-2"><Checkbox />Checkbox</label>
    <RadioGroup aria-label="Decision" defaultValue="first"><label className="group/field-label flex items-center gap-2"><RadioGroupItem value="first" />First</label><label className="group/field-label flex items-center gap-2"><RadioGroupItem value="second" />Second</label></RadioGroup>
    <div className="flex flex-col gap-1.5"><Label htmlFor="notes">Notes</Label><Textarea id="notes" placeholder="Enter a note" /></div>
    <NawabanDialog open={open} onClose={() => setOpen(false)} title="Interaction dialog">
      <Button onClick={() => setOpen(false)}>Close dialog</Button>
    </NawabanDialog>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Notices><Fixture /></Notices>);
