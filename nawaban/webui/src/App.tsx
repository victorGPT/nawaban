import { t as tr, useLocale, setLocale } from "@/i18n";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  RiInbox2Line,
  RiLayoutColumnLine,
  RiGitBranchLine,
  RiSideBarLine,
  RiSearchLine,
  RiFilter3Line,
} from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Badge } from "@/components/base/badges/badge";
import { LinkButton } from "@/components/base/buttons/link-button";
import { Input } from "@/components/base/input/input";
import { NavItem } from "@/components/application/navigation/nav-item";
import { ThemeToggle } from "@/components/application/theme/theme-toggle";
import { BoardFilterBar } from "@/components/BoardFilterBar";
import { BoardKanban } from "@/components/BoardKanban";
import { ModulesView } from "@/components/ModulesView";
import { InboxView } from "@/components/InboxView";
import { TaskDetailSheet } from "@/components/TaskDetailSheet";
import { ModuleSelect } from "@/components/base/select/module-select";
import {
  fetchInbox,
  fetchProjects,
  type DateRange,
  type Project,
} from "@/lib/api";
import { navigateTask } from "@/lib/nawaban-model";
import { cx } from "@/utils/cx";

type View = "board" | "modules" | "inbox";
export default function App() {
  const locale = useLocale();
const NAV = [
  { id: "board", label: tr("board"), icon: RiLayoutColumnLine },
  { id: "modules", label: tr("epic"), icon: RiGitBranchLine },
  { id: "inbox", label: tr("inbox"), icon: RiInbox2Line },
] as const;

  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(location.search).get("view");
    return v === "modules" || v === "inbox" ? v : "board";
  });
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<Project>(() => {
    const p = new URLSearchParams(location.search).get("project");
    if (p !== null) return p || null;
    try {
      return localStorage.getItem("project") || null;
    } catch {
      return null;
    }
  });
  const [projects, setProjects] = useState<string[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [inboxTotal, setInboxTotal] = useState<number | null>(null);
  const [decisionTasks, setDecisionTasks] = useState(new Set<string>());
  const [path, dispatch] = useReducer(navigateTask, [], () => {
    const id = new URLSearchParams(location.search).get("task");
    return id ? [id] : [];
  });
  const selectedTask = path.at(-1) ?? null;
  const [navOpen, setNavOpen] = useState(() => {
    try {
      return localStorage.getItem("navOpen") !== "0";
    } catch {
      return true;
    }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleNav = () =>
    setNavOpen((o) => {
      try {
        localStorage.setItem("navOpen", o ? "0" : "1");
      } catch {
        /* Private browsing can disable preference storage. */
      }
      return !o;
    });
  const selectTask = (id: string) => dispatch({ type: "open", id });
  const changeProject = (value: string) => {
    const next = value === "all" ? null : value;
    setProject(next);
    try {
      localStorage.setItem("project", next ?? "");
    } catch {
      /* Private browsing can disable preference storage. */
    }
    const url = new URL(location.href);
    url.searchParams.set("project", next ?? "");
    history.replaceState(null, "", url);
  };
  useEffect(() => {
    fetchProjects()
      .then((d) =>
        // Unassigned cards stay reachable under "all projects".
        setProjects(d.projects.flatMap((p) => (p.name ? [p.name] : []))),
      )
      .catch(() => setProjects([]));
  }, []);
  const navigate = (next: View) => {
    setView(next);
    setQuery("");
    const url = new URL(location.href);
    url.searchParams.set("view", next);
    history.replaceState(null, "", url);
  };
  const openDecision = (id: string) => {
    navigate("inbox");
    setQuery(id);
  };
  useEffect(() => {
    const url = new URL(location.href);
    if (selectedTask) url.searchParams.set("task", selectedTask);
    else url.searchParams.delete("task");
    history.replaceState(null, "", url);
  }, [selectedTask]);
  useEffect(() => {
    let active = true;
    const load = () =>
      fetchInbox(project)
        .then((d) => {
          if (active) {
            setInboxTotal(d.unavailable ? null : d.total);
            setDecisionTasks(
              new Set(
                d.groups.flatMap((g) => g.items.flatMap((a) => a.task_ids)),
              ),
            );
          }
        })
        .catch(() => {
          if (active) setInboxTotal(null);
        });
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing =
        ["INPUT", "TEXTAREA"].includes(el.tagName) || el.isContentEditable;
      if (
        (e.key === "/" && !typing) ||
        ((e.metaKey || e.ctrlKey) && e.key === "k")
      ) {
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
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const title = NAV.find((n) => n.id === view)!.label;
  return (
    <div className="nawaban-shell">
      <aside
        className={cx("nawaban-sidebar", !navOpen && "collapsed")}
        aria-label={tr("mainNavigation")}
      >
        <div className="nawaban-brand">
          <span className="brand-mark">
            <RiLayoutColumnLine />
          </span>
          {navOpen && (
            <div>
              <strong className="text-title-3-semibold">NAWABAN</strong>
              <p className="text-body-regular">{tr("agentWorkspace")}</p>
            </div>
          )}
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            leadingIcon={RiSideBarLine}
            onClick={toggleNav}
            aria-label={tr("toggleSidebar")}
          />
        </div>
        {navOpen && (
          <ModuleSelect
            modules={projects}
            value={project ?? "all"}
            onValueChange={changeProject}
            allLabel={tr("allProjects")}
            ariaLabel={tr("switchProject")}
            className="project-select"
          />
        )}
        {navOpen && <p className="sidebar-label text-body-medium">{tr("workspace")}</p>}
        <nav>
          {NAV.map((n) => (
            <NavItem
              key={n.id}
              icon={n.icon}
              label={n.label}
              href={`?view=${n.id}`}
              onClick={() => navigate(n.id)}
              collapsed={!navOpen}
              isSelected={view === n.id}
              badge={
                n.id === "inbox" && inboxTotal != null ? (
                  <Badge>{inboxTotal}</Badge>
                ) : undefined
              }
            />
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ThemeToggle collapsed={!navOpen} />
          <Button variant="ghost" size="small" aria-label={tr("switchLanguage")}
            title={tr("language")} onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
            {tr("languageShort")}
          </Button>
          {navOpen && (
            <p className="text-body-regular">{tr("agentsAdvanceTasks")}<br />{tr("decisionsInInbox")}</p>
          )}
        </div>
      </aside>
      <div className="nawaban-main">
        <header className="workspace-topbar">
          <span className="text-body-regular">
            {project ?? tr("allProjects")} ／ {title}
          </span>
          <LinkButton
            variant="secondary"
            size="small"
            leadingIcon={RiInbox2Line}
            onClick={() => navigate("inbox")}
          >{tr("needsAttention")}{inboxTotal != null && <Badge className="ml-2">{inboxTotal}</Badge>}
          </LinkButton>
        </header>
        <div className="page-heading">
          <h1 className="text-title-1-semibold">{title}</h1>
          <div className="page-controls">
            {view === "board" && (
              <Button
                variant={range ? "secondary" : "ghost"}
                className={
                  !range ? "bg-transparent text-text-secondary" : undefined
                }
                size="small"
                leadingIcon={RiFilter3Line}
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen(!filterOpen)}
              >{tr("updated")}</Button>
            )}
            <Input
              ref={searchRef}
              size="small"
              fieldClassName="border border-border-button-default bg-background-primary-default shadow-xs"
              leadingIcon={RiSearchLine}
              aria-label={tr("searchTasks")}
              placeholder={
                view === "modules"
                  ? tr("searchModules")
                  : view === "inbox"
                    ? tr("searchInbox")
                    : tr("searchBoard")
              }
              value={query}
              onChange={setQuery}
            />
          </div>
        </div>
        {view === "board" && (filterOpen || range) && (
          <BoardFilterBar range={range} onChange={setRange} />
        )}
        <main className="view-content">
          {view === "board" && (
            // Remounting per project drops its module filter and in-flight results.
            <BoardKanban
              key={project}
              query={query}
              range={range}
              project={project}
              onSelectTask={selectTask}
              onDecision={openDecision}
              decisionTasks={decisionTasks}
            />
          )}{" "}
          {view === "modules" && (
            <ModulesView query={query} project={project} onSelectTask={selectTask}
              onDecision={openDecision} decisionTasks={decisionTasks} />
          )}{" "}
          {view === "inbox" && (
            <InboxView key={project} query={query} project={project} onSelectTask={selectTask} />
          )}
        </main>
      </div>
      <TaskDetailSheet
        taskId={selectedTask}
        onSelectTask={selectTask}
        onOpenChange={(open) => !open && dispatch({ type: "close" })}
        onBack={path.length > 1 ? () => dispatch({ type: "back" }) : undefined}
      />
    </div>
  );
}
