// nawaban board, read-only: the tasks of the project the shown space works in, grouped as the web
// board's columns. Data comes from the nawaban CLI (`nawaban json ...`), so no board server is needed.
// The CLI is the checkout docs/install.md puts at ~/nawaban; it runs in the space's folder without
// --db, so it finds the same board an agent working there does.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, InputState, Input, TextView } from "gpui-base";
import { spaces, focused, exec, theme, home, props } from "herdr";
import { groupTasks, projectFor, resolveLang, filterGroups, ago, shortId, linkParts, eventMarkdown, detailEvents, isBlocked, WORDS }
  from "./logic.js";

const POLL_MS = 5000;
const SHOWN = { open: 8, done: 5 }; // rows a group shows before "show N more"
const ID_W = 132; // the ID column
const ID_CHARS = 18; // longer IDs are cut in the middle to fit ID_W, keeping their distinguishing tail
const EVENTS_SHOWN = 8; // events a detail lists before "show N more"
const BODY_FOLD_CHARS = 600, BODY_FOLDED_H = 240; // a longer body shows its top until "show all"
const ICON = (name) => `mods/nawaban-board/${name}.svg`;
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`; // Herdr's shipped icons
const KIND_ICON = { note: CHROME("file-text"), decision: CHROME("circle-check"), link: ICON("link") };
const cli = () => `${home()}/nawaban/nawaban/cli.py`;

// The shown space's folder; home for a remote space (v1 reads this computer's board only).
function folder() {
  const space = spaces().find((s) => s.active);
  if (space?.machine) return home();
  return focused()?.cwd || space?.folder || home();
}

async function nawaban(args, cwd) {
  const r = await exec("python3", [cli(), ...args], { cwd });
  let out = null;
  try { out = JSON.parse(r.stdout || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim().split("\n").pop() || `exit ${r.code}`);
  return { out, raw: r.stdout };
}

export default class NawabanBoard extends View {
  // props().task: open on that task's detail (`pane.split` with `"props": {"task": "<ID>"}`).
  init(_props, cx) {
    this.groups = null;
    this.error = null;
    this.scope = null;          // null: the space's project; "*": all projects; else a project picked
    this.projects = new Map();  // folder -> its project (null: none), resolved once per folder
    this.projectList = [];      // the board's projects, for the picker
    this.chip = "all";
    this.shut = new Set();      // folded groups
    this.expanded = new Set();  // groups showing every row
    this.trail = [];            // tasks opened, the shown one last; empty: the list
    this.detail = null;         // `nawaban json task` of the shown task
    try { this.lang = localStorage.getItem("lang"); } catch { this.lang = null; }
    if (this.lang !== "zh" && this.lang !== "en") {
      this.lang = "en";
      cx.spawn(async (cx) => {
        let r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
        if (r?.code !== 0) r = await exec("sh", ["-c", 'printf %s "$LANG"']).catch(() => null);
        this.setLang(resolveLang(null, r?.stdout), cx);
      });
    }
    this.makeQuery(cx);
    this.refresh(cx);
    const task = props()?.task;
    if (task) this.open(String(task), cx);
    cx.timer.every(POLL_MS, (cx) => { this.refresh(cx); this.loadDetail(cx); });
  }

  // A task's detail. Its blockers, dependents, subtasks and parent open on top of it; "back" goes
  // one step, to the list last. The list stays rendered (hidden) underneath, keeping its scroll.
  open(id, cx) {
    this.trail.push(id);
    this.allEvents = this.fullBody = false;
    this.loadDetail(cx);
    cx.notify();
  }

  back(cx) {
    this.trail.pop();
    this.allEvents = this.fullBody = false;
    this.loadDetail(cx);
    cx.notify();
  }

  loadDetail(cx) {
    const id = this.trail.at(-1);
    if (!id) return;
    cx.spawn(async (cx) => {
      try {
        const { out, raw } = await nawaban(["json", "task", id], folder());
        if (this.trail.at(-1) !== id) return;
        this.detailError = null;
        if (raw !== this.detailRaw) { this.detailRaw = raw; this.detail = out; }
      } catch (e) {
        if (this.trail.at(-1) === id) this.detailError = String(e?.message ?? e);
      } finally {
        cx.notify();
      }
    });
  }

  // The filter box; made again when the language changes, as its placeholder is fixed at creation.
  makeQuery(cx) {
    const value = this.query?.value() ?? "";
    this.query = InputState.new({ placeholder: WORDS[this.lang].filter, value });
    this.query.on("change", (_e, cx) => cx.notify());
    cx.notify();
  }

  setLang(lang, cx) {
    if (lang === this.lang) return;
    this.lang = lang;
    this.makeQuery(cx);
  }

  key() { return `${folder()}|${this.scope}`; }

  refresh(cx) {
    if (this.loading) return;
    const cwd = folder();
    if (cwd !== this.cwd) { this.cwd = cwd; this.scope = null; } // a new space: follow its project again
    const key = this.key(), scope = this.scope;
    this.loading = true;
    this.context = key;
    cx.spawn(async (cx) => {
      try {
        if (!this.projects.has(cwd)) {
          const git = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
          const { out } = await nawaban(["json", "projects"], cwd);
          this.projects.set(cwd, projectFor(git.code === 0 ? git.stdout : "", out));
          this.projectList = out.projects;
        }
        const own = this.projects.get(cwd);
        const project = scope === "*" ? null : scope ?? own;
        const { out, raw } = await nawaban(["json", "board", ...(project ? ["--project", project] : [])], cwd);
        if (this.key() !== key) return; // the space or scope changed meanwhile: the next refresh reads it
        this.own = own;
        this.project = project;
        this.error = null;
        if (raw === this.raw) return;
        this.raw = raw;
        this.groups = groupTasks(out);
      } catch (e) {
        this.error = String(e?.message ?? e); // keep the last list shown
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // The picker's list is read again each time it opens, so new projects show up.
  readProjects(cx) {
    cx.spawn(async (cx) => {
      try { this.projectList = (await nawaban(["json", "projects"], folder())).out.projects; cx.notify(); } catch {}
    });
  }

  pickScope(scope, cx) {
    this.scope = scope === this.own ? null : scope;
    this.pickerOpen = false;
    this.raw = null;
    this.refresh(cx);
  }

  render(cx) {
    if (this.key() !== this.context) this.refresh(cx);
    const t = theme(), w = WORDS[this.lang];
    const query = this.query.value();
    const all = this.groups ?? [];
    const searched = filterGroups(all, query, "all");
    const count = (k) => k === "blocked" ? searched[1]?.tasks.filter((x) => x.blocked).length ?? 0
      : k === "open" ? searched[1]?.tasks.filter((x) => !x.blocked).length ?? 0
      : searched.find((g) => g.key === k)?.tasks.length ?? 0;
    const shown = filterGroups(all, query, this.chip);
    const narrowed = Boolean(query.trim()) || this.chip !== "all";

    const note = this.error ? `${w.error}: ${this.error}` : !this.groups ? w.loading
      : all.every((g) => !g.tasks.length) ? w.empty : shown.every((g) => !g.tasks.length) ? w.none : null;

    const detail = this.trail.length > 0;
    return v_flex().id("nawaban-board").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .when(!detail, (el) => el.child(this.header(t, w))
        .child(this.filterBox(t))
        .child(h_flex().flex_none().px(6).pt(6).gap(2)
          .child(this.chipEl("all", w.statuses, 0, t))
          .children(["in_progress", "open", "blocked"].map((k) => this.chipEl(k, w[k], count(k), t)))))
      .when(detail, (el) => el.child(this.detailView(t, w)))
      .child(v_flex().id("nawaban-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(6)
        .when(detail, (el) => el.hidden().flex_none().h(0)) // hidden alone still takes half the height
        .when(Boolean(note), (el) => el.child(div().px(8).py(8).text_size(12).text_color(this.error ? t.blocked : t.dim).child(note)))
        .children(shown.filter((g) => g.tasks.length || !narrowed).map((g) => this.group(g, narrowed, t, w))));
  }

  header(t, w) {
    const iconButton = (id) => h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(6)
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground));
    const label = this.project ?? w.all;
    const picker = Popover.new("nawaban-project-menu").anchor("top_right").open(Boolean(this.pickerOpen))
      .on_open_change((open, cx) => { this.pickerOpen = open; if (open) this.readProjects(cx); cx.notify(); })
      .trigger(h_flex().id("nawaban-project").h(24).max_w(200).flex_none().pl(8).pr(6).gap(4).items_center().rounded(6)
        .cursor_pointer().text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(div().min_w(0).truncate().child(label))
        .child(svg(CHROME("chevron-down")).size(12).flex_none().text_color(t.dim)))
      .content(this.menu("nawaban-projects", [
        { key: "*", label: w.all, on: !this.project },
        ...this.projectList.filter((p) => p.name).map((p) => ({ key: p.name, label: p.name, hint: String(p.open), on: p.name === this.project })),
      ], (k, cx) => this.pickScope(k, cx), t));
    const more = Popover.new("nawaban-more-menu").anchor("top_right").open(Boolean(this.moreOpen))
      .on_open_change((open, cx) => { this.moreOpen = open; cx.notify(); })
      .trigger(iconButton("nawaban-more").child(svg(ICON("more")).size(16).flex_none()))
      .content(this.menu("nawaban-lang", [
        { key: "zh", label: "中文", on: this.lang === "zh" },
        { key: "en", label: "English", on: this.lang === "en" },
      ], (lang, cx) => {
        try { localStorage.setItem("lang", lang); } catch {}
        this.moreOpen = false;
        this.setLang(lang, cx);
      }, t, w.language));
    return h_flex().h(42).flex_none().pl(14).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().font_semibold().child(w.title))
      .child(picker)
      .child(more);
  }

  // A popup list of choices, the picked one checked; `title` is a dim heading over it.
  menu(id, items, pick, t, title = null) {
    return v_flex().id(id).w(220).max_h(360).mt(4).p(4).gap(1).rounded(8).overflow_y_scroll()
      .bg(t.popover).border_1().border_color(t.border).text_size(13)
      .when(Boolean(title), (el) => el.child(div().h(26).px(8).flex().items_center().text_size(12).text_color(t.dim).child(title)))
      .children(items.map((x) => h_flex().id(`${id}-${x.key}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { pick(x.key, cx); cx.notify(); })
        .child(div().size(16).flex_none().when(x.on, (el) => el.child(svg(CHROME("check")).size(16).text_color(t.foreground))))
        .child(div().flex_1().min_w(0).truncate().child(x.label))
        .when(Boolean(x.hint), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(x.hint)))));
  }

  filterBox(t) {
    return div().flex_none().px(6).pt(6)
      .child(h_flex().id("nawaban-filter").h(30).pl(9).pr(6).gap(7).items_center().rounded(8).border_1()
        .border_color(t.input).bg(t.background)
        .child(svg(CHROME("search")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.query).flex_1().min_w(0).text_size(13).text_color(t.foreground)));
  }

  chipEl(key, label, n, t) {
    const on = this.chip === key;
    return h_flex().id(`nawaban-chip-${key}`).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.chip = key; cx.notify(); })
      .child(label)
      .when(n > 0, (el) => el.child(div().text_color(t.dim).child(String(n))));
  }

  // A heading that folds the group (chevron, name, count at the right), then its rows; long groups
  // show their newest few behind "show N more" unless the list is filtered. Blocked tasks always
  // show, after the cut, so their mark is never hidden.
  group(g, narrowed, t, w) {
    const shut = !narrowed && this.shut.has(g.key);
    const free = g.tasks.filter((x) => !x.blocked), blocked = g.tasks.filter((x) => x.blocked);
    const limit = narrowed || this.expanded.has(g.key) ? Infinity : SHOWN[g.key] ?? Infinity;
    const cut = Math.max(0, free.length - limit);
    const toggle = (set, k) => (set.has(k) ? set.delete(k) : set.add(k));
    return v_flex().flex_none().gap(1)
      .child(h_flex().id(`nawaban-head-${g.key}`).h(30).px(8).gap(10).items_center().rounded(8).text_size(12)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { toggle(this.shut, g.key); cx.notify(); })
        .child(h_flex().w(16).h(16).flex_none().items_center().justify_center()
          .child(svg(CHROME(`chevron-${shut ? "right" : "down"}`)).size(12).flex_none().text_color(t.dim)))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.dim).child(w[g.key]))
        .child(div().flex_none().text_color(t.dim).child(String(g.tasks.length))))
      .when(!shut, (el) => el.children(free.slice(0, free.length - cut).map((task) => this.row(task, t, w)))
        .when(!narrowed && free.length > (SHOWN[g.key] ?? Infinity), (el) => el
          .child(h_flex().id(`nawaban-more-${g.key}`).h(28).pl(34).pr(8).items_center().rounded(8).cursor_pointer()
            .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { toggle(this.expanded, g.key); cx.notify(); })
            .child(cut > 0 ? w.more(cut) : w.less)))
        .children(blocked.map((task) => this.row(task, t, w))));
  }

  // One task: its status icon, the dim ID in a fixed column, the title; an in-progress task adds
  // its latest note and how long ago on a second line. With all projects, the project at the right.
  row(task, t, w) {
    const where = !this.project && task.project ? task.project : null;
    const first = h_flex().h(18).min_w(0).gap(8).items_center()
      .child(div().w(ID_W).flex_none().truncate().text_size(11).text_color(t.dim).child(shortId(task.id, ID_CHARS)))
      .child(div().flex_1().min_w(0).truncate().text_color(task.status === "done" ? t.muted : t.foreground).child(task.title))
      .when(Boolean(where), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(12).text_color(t.dim).child(where)));
    const tip = task.blocked ? (task.blocked_by?.length ? w.blockedBy(task.blocked_by) : w.blocked) : null;
    const row = h_flex().id(`nawaban-task-${task.id}`).flex_none().px(8).gap(10).rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(task.id, cx))
      .when(Boolean(tip), (el) => el.tooltip(tip));
    const glyph = this.glyph(task.status, task.blocked, t);
    if (task.status !== "in_progress") return row.h(32).items_center().child(glyph).child(first.flex_1());
    const said = task.progress?.body?.replace(/\s+/g, " ").trim();
    const at = task.progress?.at ?? task.active_at;
    const second = h_flex().h(16).gap(8).items_center().pl(ID_W + 8)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(said ?? ""))
      .when(Boolean(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(at, Math.floor(Date.now() / 1000), this.lang))));
    return row.py(6).items_start().child(glyph).child(v_flex().flex_1().min_w(0).gap(2).child(first).child(second));
  }

  // A task's status icon: in progress, open, blocked, done (cancelled shows as done).
  glyph(status, blocked, t) {
    const [icon, color] = status === "in_progress" ? ["working", t.working] : blocked ? ["blocked", t.blocked]
      : status === "done" || status === "cancelled" ? ["done", t.dim] : ["open", t.muted];
    return h_flex().w(16).h(18).flex_none().items_center().justify_center().child(svg(ICON(icon)).size(16).text_color(color));
  }

  // The shown task: "‹ back" and its ID on top; below, scrolling, its title and status, current
  // progress, body, related tasks and its notes, decisions and links.
  detailView(t, w) {
    const id = this.trail.at(-1);
    const d = this.detail?.id === id ? this.detail : null;
    const head = h_flex().h(42).flex_none().pl(6).pr(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("nawaban-back").h(26).pl(2).pr(8).gap(2).flex_none().items_center().rounded(6).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.back(cx))
        .child(svg(CHROME("chevron-left")).size(16).flex_none())
        .child(w.back))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(id));
    const note = this.detailError ? `${w.error}: ${this.detailError}` : !d ? w.loading : null;
    return v_flex().flex_1().min_h(0)
      .child(head)
      .when(Boolean(note), (el) => el.child(div().px(14).py(12).text_size(12).text_color(this.detailError ? t.blocked : t.dim).child(note)))
      .when(Boolean(d), (el) => el.child(this.detailBody(d, t, w)));
  }

  detailBody(d, t, w) {
    const now = Math.floor(Date.now() / 1000);
    const blocked = isBlocked(d);
    const state = blocked ? "blocked" : d.status;
    const color = { in_progress: t.working, blocked: t.blocked }[state] ?? t.muted;
    const meta = h_flex().flex_wrap().gap(6).items_center().text_size(12).text_color(t.dim)
      .child(h_flex().h(22).pl(4).pr(8).gap(4).items_center().rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(this.glyph(d.status, blocked, t)).child(div().text_color(color).child(w.state[state] ?? d.status)))
      .when(Boolean(d.project), (el) => el.child(div().child(d.project)))
      .child(div().child("·")).child(div().child(ago(d.created_at, now, this.lang)));
    const progress = (d.status === "open" || d.status === "in_progress") && d.latest_note;
    const relations = ["blocked_by", "dependents", "children"].filter((k) => d[k]?.length)
      .map((k) => this.section(w.relations[k], d[k].length, t,
        v_flex().gap(1).children(d[k].map((r) => this.related(r, k, t)))));
    const long = (d.body ?? "").length > BODY_FOLD_CHARS;
    const events = detailEvents(d.events);
    const shown = this.allEvents ? events : events.slice(0, EVENTS_SHOWN);
    return v_flex().id(`nawaban-detail-${d.id}`).flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(14).pb(20).gap(18)
      .child(v_flex().flex_none().gap(8)
        .child(div().text_size(15).font_semibold().line_height("22px").child(d.title))
        .child(meta)
        .when(Boolean(d.parent), (el) => el.child(h_flex().gap(6).items_center().text_size(12)
          .child(div().flex_none().text_color(t.dim).child(w.parent))
          .child(this.related(d.parent, "parent", t).flex_1()))))
      .when(Boolean(progress), (el) => el.child(v_flex().flex_none().p(10).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
          .child(svg(ICON("working")).size(12).flex_none().text_color(t.working))
          .child(div().flex_1().font_medium().child(w.progress))
          .child(div().child(ago(progress.at, now, this.lang))))
        .child(TextView.markdown(`nawaban-progress-${d.id}`, eventMarkdown(progress.body)).selectable(true).scrollable(false))))
      .children(relations)
      .when(Boolean(d.body?.trim()), (el) => el.child(this.section(w.body, null, t, v_flex().gap(4)
        .child(div().when(long && !this.fullBody, (el) => el.max_h(BODY_FOLDED_H).overflow_hidden())
          .child(TextView.markdown(`nawaban-body-${d.id}`, d.body).selectable(true).scrollable(false)))
        .when(long, (el) => el.child(this.moreRow("nawaban-body-more", this.fullBody ? w.less : w.wholeBody, t,
          (cx) => { this.fullBody = !this.fullBody; cx.notify(); }))))))
      .when(events.length > 0, (el) => el.child(this.section(w.events, events.length, t,
        v_flex().gap(6)
          .children(shown.map((e, i) => this.eventEl(d.id, e, i, now, t, w)))
          .when(events.length > EVENTS_SHOWN, (el) => el.child(this.moreRow("nawaban-events-more",
            this.allEvents ? w.less : w.more(events.length - EVENTS_SHOWN), t,
            (cx) => { this.allEvents = !this.allEvents; cx.notify(); }))))));
  }

  moreRow(id, label, t, click) {
    return h_flex().id(id).h(28).px(8).items_center().rounded(8).cursor_pointer().text_size(12).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)).child(label);
  }

  // A heading (dim, with a count) over its content.
  section(title, n, t, content) {
    return v_flex().flex_none().gap(8)
      .child(h_flex().gap(6).items_center().text_size(12).font_medium().text_color(t.dim)
        .child(title).when(n != null, (el) => el.child(div().text_color(t.dim).child(String(n)))))
      .child(content);
  }

  // A related task, opened on click: its status icon, ID and title.
  related(r, key, t) {
    return h_flex().id(`nawaban-${key}-${r.id}`).h(30).min_w(0).px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .bg(t.surface).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(r.id, cx))
      .child(this.glyph(r.status, false, t))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(shortId(r.id, ID_CHARS)))
      .child(div().flex_1().min_w(0).truncate().text_color(r.status === "done" ? t.muted : t.foreground).child(r.title));
  }

  // One note, decision or link: its kind, who and when, then the text; a link with a web address
  // opens in the browser.
  eventEl(taskId, e, i, now, t, w) {
    const who = e.author === "user" ? w.user : String(e.author ?? "").slice(0, 8);
    const top = h_flex().h(18).gap(6).items_center().text_size(12).text_color(t.dim)
      .child(svg(KIND_ICON[e.kind]).size(14).flex_none().text_color(e.kind === "decision" ? t.accent : t.muted))
      .child(div().flex_none().font_medium().text_color(t.muted).child(w.kinds[e.kind]))
      .child(div().flex_1().min_w(0).truncate().child(who))
      .child(div().flex_none().child(ago(e.at, now, this.lang)));
    let body;
    if (e.kind === "link") {
      const l = linkParts(e.body);
      body = h_flex().id(`nawaban-link-${i}`).h(30).min_w(0).px(8).gap(8).items_center().rounded(8).bg(t.surface)
        .when(Boolean(l.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.open_url(l.url)))
        .when(Boolean(l.kind), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(l.kind)))
        .child(div().flex_1().min_w(0).truncate().text_color(l.url ? t.accent : t.foreground).child(l.value))
        .when(Boolean(l.note), (el) => el.child(div().flex_none().max_w(140).truncate().text_size(12).text_color(t.muted).child(l.note)));
    } else {
      body = div().pl(20).child(TextView.markdown(`nawaban-event-${taskId}-${i}`, eventMarkdown(e.body)).selectable(true).scrollable(false));
    }
    return v_flex().flex_none().gap(4).py(6).border_t(1).border_color(t.border).child(top).child(e.kind === "link" ? body.ml(20) : body);
  }
}
