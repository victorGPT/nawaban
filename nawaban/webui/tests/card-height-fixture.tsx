import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskCard, type TaskCardData } from "@/components/TaskCard";
import { Button } from "@/components/base/buttons/button";
import { setLocale, type Locale } from "@/i18n";
import "@/index.css";

// Isolated real-browser fixture. No board API, task writes, or persisted data.
const now = Date.now() / 1000;
const cases = [
  ["fresh", 0, null], ["stale", 1, null], ["waiting", 0, "decision"],
  ["both", 7, "decision"], ["deploy", 3, "prod"], ["observe", 7, "observe"],
  ["external", 3, "external"], ["unknown-long", 7, "waiting_for_a_very_long_external_identifier"],
] as const;

export function CardHeightFixture() {
  const [locale, updateLocale] = useState<Locale>("zh-CN");
  const [dark, setDark] = useState(false);
  const [report, setReport] = useState("Measuring");
  useLayoutEffect(() => {
    setLocale(locale);
    document.documentElement.classList.toggle("dark", dark);
    const frame = requestAnimationFrame(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".task-card")].map((el) => ({
        id: el.parentElement!.dataset.cardId,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        footerInside: el.querySelector(".task-card-footer")!.getBoundingClientRect().right <= el.getBoundingClientRect().right,
      }));
      const heights = [...new Set(rows.map((r) => r.height))];
      setReport(JSON.stringify({ locale, theme: dark ? "dark" : "light", count: rows.length,
        heights, pass: rows.every((r) => Math.abs(r.height - 124) < 0.1 && r.footerInside) }, null, 2));
    });
    return () => cancelAnimationFrame(frame);
  }, [locale, dark]);
  return <main className="p-4">
    <h1>Task card height verification</h1>
    <Button onClick={() => updateLocale(locale === "zh-CN" ? "en" : "zh-CN")}>Switch language</Button>{" "}
    <Button onClick={() => setDark(!dark)}>Switch theme</Button>
    <pre aria-label="Height measurements">{report}</pre>
    {[940, 1280, 1600].map((width) => <section key={width}>
      <h2>Board width {width}</h2>
      <div className="kanban" style={{ width }}>
        {cases.map(([id, days, waiting], index) => {
          const task: TaskCardData = {
            id: `${width}-${id}`, title: index % 2 ? "A very long task title that wraps across several lines and must stay within its two-line title slot" : "Short task",
            epic: "Example", status: index === 7 ? "claimed" : "in_progress",
            active_at: now - days * 86400, waiting_on: waiting,
          };
          return <div className="board-column" key={id}><TaskCard task={task} hasAsk={false}
            onSelect={() => {}} onDecision={() => {}} /></div>;
        })}
      </div>
    </section>)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<CardHeightFixture />);
