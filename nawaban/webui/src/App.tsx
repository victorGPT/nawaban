import { t as tr, useLocale, setLocale } from "@/i18n";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  RiLayoutColumnLine,
  RiSideBarLine,
  RiSearchLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NavItem } from "@/components/application/navigation/nav-item";
import { ThemeToggle } from "@/components/application/theme/theme-toggle";
import { BoardFilterBar } from "@/components/BoardFilterBar";
import { BoardKanban } from "@/views/board";
import { TaskDetailSheet } from "@/views/task-detail";
import { ModuleSelect } from "@/components/application/select/module-select";
import {
  fetchProjects,
  type DateRange,
  type Project,
} from "@/lib/api";
import { navigateTask } from "@/lib/nawaban-model";
import { cx } from "@/utils/cx";

// The page has one view, the board; a task opens as a detail drawer over it (?task=).
export default function App() {
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<Project>(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("unassigned") === "1") return "";
    const p = params.get("project");
    if (p !== null) return p || null;
    try {
      if (localStorage.getItem("projectUnassigned") === "1") return "";
      return localStorage.getItem("project") || null;
    } catch {
      return null;
    }
  });
  const [projects, setProjects] = useState<string[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);
  const [path, dispatch] = useReducer(navigateTask, [], () => {
    const id = new URLSearchParams(location.search).get("task");
    return id ? [id] : [];
  });
  const selectedTask = path.at(-1) ?? null;
  const [navOpen, setNavOpen] = useState(() => {
    try {
      return window.innerWidth > 650 && localStorage.getItem("navOpen") !== "0";
    } catch {
      return true;
    }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const topbarToggleRef = useRef<HTMLButtonElement>(null);
  const restoreNavFocus = useRef(false);
  useEffect(() => {
    if (restoreNavFocus.current) {
      (navOpen ? sidebarToggleRef : topbarToggleRef).current?.focus();
      restoreNavFocus.current = false;
    }
  }, [navOpen]);
  const toggleNav = () => {
    restoreNavFocus.current = true;
    setNavOpen((o) => {
      try {
        localStorage.setItem("navOpen", o ? "0" : "1");
      } catch {
        /* Private browsing can disable preference storage. */
      }
      return !o;
    });
  };
  const selectTask = (id: string) => dispatch({ type: "open", id });
  const changeProject = (value: string) => {
    const next = value === "all" ? null : value.slice("project:".length);
    setProject(next);
    try {
      localStorage.setItem("project", next ?? "");
      localStorage.setItem("projectUnassigned", next === "" ? "1" : "0");
    } catch {
      /* Private browsing can disable preference storage. */
    }
    const url = new URL(location.href);
    url.searchParams.set("project", next ?? "");
    if (next === "") url.searchParams.set("unassigned", "1");
    else url.searchParams.delete("unassigned");
    history.replaceState(null, "", url);
  };
  useEffect(() => {
    fetchProjects()
      .then((d) => {
        const names = d.projects.flatMap((p) => (p.name ? [p.name] : []));
        setProjects(names);
        // A remembered project can be renamed or removed; keeping it shows an empty board.
        if (project && !names.includes(project)) changeProject("all");
      })
      .catch(() => setProjects([]));
    // Runs once: only the project remembered at load needs checking.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    if (selectedTask) url.searchParams.set("task", selectedTask);
    else url.searchParams.delete("task");
    history.replaceState(null, "", url);
  }, [selectedTask]);
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
  const controls = (
          <div className="page-controls">
            <div className="search-control">
            <RiSearchLine
              className="pointer-events-none absolute top-1/2 left-2 size-[18px] -translate-y-1/2 text-foreground-icon-secondary"
              aria-hidden="true"
            />
            <Input
              ref={searchRef}
              className="rounded-2lg pl-8 text-body-medium bg-background-primary-default shadow-xs"
              aria-label={tr("searchTasks")}
              aria-keyshortcuts="/ Control+k Meta+k"
              placeholder={tr("searchBoard")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd className="search-shortcut text-caption-1-regular" aria-hidden="true">/</kbd>
            </div>
          </div>
  );
  return (
    <div className="nawaban-shell">
      <aside
        className={cx("nawaban-sidebar", !navOpen && "collapsed")}
        aria-label={tr("mainNavigation")}
        hidden={!navOpen}
      >
        <div className="nawaban-brand">
          <strong className="brand-name">nawaban</strong>
          <Button
            ref={sidebarToggleRef}
            variant="soft"
            size="icon-xs"
            onClick={toggleNav}
            aria-label={tr("toggleSidebar")}
          >
            <RiSideBarLine aria-hidden="true" />
          </Button>
        </div>
        {navOpen && (
          <div className="sidebar-project-picker">
          <span className="text-caption-1-regular">{tr("switchProject")}</span>
          <ModuleSelect
            modules={[...projects, ""].map((p) => `project:${p}`)}
            value={project === null ? "all" : `project:${project}`}
            getLabel={(value) => value.slice("project:".length) || tr("noProject")}
            onValueChange={changeProject}
            allLabel={tr("allProjects")}
            ariaLabel={tr("switchProject")}
            className="project-select"
          />
          </div>
        )}
        {navOpen && <p className="sidebar-label text-body-medium">{tr("workspace")}</p>}
        <nav>
          <NavItem
            icon={RiLayoutColumnLine}
            label={tr("board")}
            onClick={() => {}}
            collapsed={!navOpen}
            isSelected
          />
        </nav>
        <div className="sidebar-bottom">
          <ThemeToggle collapsed={!navOpen} />
          <Button variant="soft" aria-label={tr("switchLanguage")}
            title={tr("language")} onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
            {tr("languageShort")}
          </Button>
          {navOpen && (
            <p className="text-body-regular">{tr("agentsAdvanceTasks")}</p>
          )}
        </div>
      </aside>
      <div className="nawaban-main">
        <header className="workspace-topbar">
          {!navOpen && <Button ref={topbarToggleRef} variant="soft" size="icon-xs"
            onClick={toggleNav} aria-label={tr("toggleSidebar")}>
            <RiSideBarLine aria-hidden="true" />
          </Button>}
          <span className="workspace-crumb text-body-regular">
            {project === "" ? tr("noProject") : project ?? tr("allProjects")} ／
          </span>
          <h1 className="text-body-medium">{tr("board")}</h1>
        </header>
        <main className="view-content">
          {/* Remounting per project drops in-flight results. */}
          <BoardKanban
            key={project}
            controls={controls}
            filters={<BoardFilterBar range={range} onChange={setRange} />}
            query={query}
            range={range}
            project={project}
            onSelectTask={selectTask}
          />
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
