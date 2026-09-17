import { t, useLocale, setLocale } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Inbox, LayoutGrid, ListFilter, Network, PanelLeft } from "lucide-react";
import { BoardFilterBar } from "@/components/BoardFilterBar";
import { BoardKanban } from "@/components/BoardKanban";
import { InboxView } from "@/components/InboxView";
import { ModulesView } from "@/components/ModulesView";
import { TaskDetailSheet } from "@/components/TaskDetailSheet";
import { cn } from "@/lib/utils";
import { fetchInbox, type DateRange } from "@/lib/api";

type View = "board" | "modules" | "inbox";

function App() {
  const locale = useLocale();
  const NAV: { id: View; label: string; icon: typeof Inbox }[] = [
    { id: "board", label: t("board"), icon: LayoutGrid },
    { id: "modules", label: t("epic"), icon: Network },
    { id: "inbox", label: t("inbox"), icon: Inbox },
  ];
  const [view, setView] = useState<View>("board");
  const [query, setQuery] = useState("");

  const [range, setRange] = useState<DateRange | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxTotal, setInboxTotal] = useState<number | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);

  const [navOpen, setNavOpen] = useState(() => {
    try { return localStorage.getItem("navOpen") !== "0"; } catch { return true; }
  });
  const toggleNav = () =>
    setNavOpen((o) => {
      try { localStorage.setItem("navOpen", o ? "0" : "1"); } catch { /* Storage unavailable. */ }
      return !o;
    });
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () => fetchInbox().then((d) => setInboxTotal(d.total)).catch(() => {});
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

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
          NAWABAN
          <button
            aria-label={t("collapseSidebarLabel")}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={toggleNav}
            title={t("collapseSidebar")}
            type="button"
          >
            <PanelLeft className="size-4" />
          </button>
        </div>
        <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">{t("workspace")}</div>
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
        <button
          className="mt-auto mb-4 flex h-8 items-center justify-between rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          type="button"
          aria-label={t("switchLanguage")}
          onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}
        >
          <span>{t("switchLanguage")}</span>
        </button>
      </nav>}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-4 border-b px-4 text-ui">
          {!navOpen && (
            <button
              aria-label={t("expandSidebarLabel")}
              className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={toggleNav}
              title={t("expandSidebar")}
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
              {t("filter")}{range && " · 1"}
            </button>
          )}
          <input
            className="ml-auto h-7 w-full max-w-xs rounded-md border bg-transparent px-2.5 outline-none placeholder:text-muted-foreground focus:border-card-hover-border"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
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
