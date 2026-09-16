import { useEffect, useRef, useState } from "react";
import { Inbox, LayoutGrid, ListFilter, Network, PanelLeft } from "lucide-react";
import { BoardFilterBar } from "@/components/BoardFilterBar";
import { BoardKanban } from "@/components/BoardKanban";
import { InboxView } from "@/components/InboxView";
import { ModulesView } from "@/components/ModulesView";
import { TaskDetailSheet } from "@/components/TaskDetailSheet";
import { cn } from "@/lib/utils";
import { fetchInbox, type DateRange } from "@/lib/api";

// 壳子按 Linear 真页尺度(2026-09-07 量):侧栏 244px · 导航项 13/500 · 段标题 12/500 三级色 ·
// 每个视图自己一条 44px 顶栏(标题 + 搜索)。层级靠对比度不靠字号。
type View = "board" | "modules" | "inbox";
const NAV: { id: View; label: string; icon: typeof Inbox }[] = [
  { id: "board", label: "看板", icon: LayoutGrid },
  { id: "modules", label: "模块", icon: Network },
  { id: "inbox", label: "收件箱", icon: Inbox },
];

function App() {
  const [view, setView] = useState<View>("board");
  const [query, setQuery] = useState("");
  // 看板「更新时间」筛(Linear 式):null = 不筛;筛选栏开着但没选也算不筛
  const [range, setRange] = useState<DateRange | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxTotal, setInboxTotal] = useState<number | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  // 侧栏折叠(Linear:整栏收起 · 顶栏左侧留展开钮 · 快捷键 `[`);记 localStorage,读不到就展开
  const [navOpen, setNavOpen] = useState(() => {
    try { return localStorage.getItem("navOpen") !== "0"; } catch { return true; }
  });
  const toggleNav = () =>
    setNavOpen((o) => {
      try { localStorage.setItem("navOpen", o ? "0" : "1"); } catch { /* 私密窗口等:不记 */ }
      return !o;
    });
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () => fetchInbox().then((d) => setInboxTotal(d.total)).catch(() => {});
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  // 全局 `/` 聚焦搜索,Esc 清空并失焦 —— 旧板的习惯,不装快捷键库,原生 keydown 够用。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "[" && !typing) {
        e.preventDefault();
        toggleNav();
      } else if (e.key === "Escape" && el === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const title = NAV.find((n) => n.id === view)!.label;

  return (
    <div className="flex h-screen">
      {navOpen && <nav className="flex w-[244px] shrink-0 flex-col bg-panel px-3 pt-4 text-ui">
        <div className="mb-5 flex items-center px-2 font-semibold text-fg-secondary">
          WORKOS
          <button
            aria-label="收起侧栏([)"
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={toggleNav}
            title="收起侧栏  ["
            type="button"
          >
            <PanelLeft className="size-4" />
          </button>
        </div>
        <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">工作区</div>
        {NAV.map((n) => (
          <button
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2 font-medium",
              view === n.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            key={n.id}
            onClick={() => setView(n.id)}
            type="button"
          >
            <n.icon className="size-4" />
            {n.label}
            {n.id === "inbox" && inboxTotal != null && inboxTotal > 0 && (
              <span className="ml-auto text-xs text-muted-foreground">{inboxTotal}</span>
            )}
          </button>
        ))}
      </nav>}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-4 border-b px-4 text-ui">
          {!navOpen && (
            <button
              aria-label="展开侧栏([)"
              className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={toggleNav}
              title="展开侧栏  ["
              type="button"
            >
              <PanelLeft className="size-4" />
            </button>
          )}
          <span className="font-medium text-fg-secondary">{title}</span>
          {view === "board" && (
            <button
              aria-expanded={filterOpen || !!range}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs",
                range ? "border-card-hover-border text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setFilterOpen((o) => !o)}
              type="button"
            >
              <ListFilter className="size-3.5" />
              筛选{range && " · 1"}
            </button>
          )}
          <input
            className="ml-auto h-7 w-full max-w-xs rounded-md border bg-transparent px-2.5 outline-none placeholder:text-muted-foreground focus:border-card-hover-border"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 id / 标题 / owner / epic(/ 聚焦 · Esc 清空)"
            ref={searchRef}
            value={query}
          />
        </header>
        {view === "board" && (filterOpen || range) && <BoardFilterBar onChange={setRange} range={range} />}
        <main className="min-h-0 flex-1">
          {view === "board" && <BoardKanban onSelectTask={setSelectedTask} query={query} range={range} />}
          {view === "modules" && <ModulesView onSelectTask={setSelectedTask} query={query} />}
          {view === "inbox" && <InboxView onSelectTask={setSelectedTask} query={query} />}
        </main>
      </div>

      <TaskDetailSheet
        onOpenChange={(open) => !open && setSelectedTask(null)}
        onSelectTask={setSelectedTask}
        taskId={selectedTask}
      />
    </div>
  );
}

export default App;
