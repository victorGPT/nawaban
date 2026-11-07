// nawaban board, read-only: the windows (Herdr agent terminals) of the focused space, joined with
// the board of the project that space works in (leadersView in logic.js, DESIGN.md's line view).
// A card per window waiting on you, then one group per leader, its items on a rail in the order
// they arrived, the windows holding no task in one last row; a click goes to the window.
// Board data comes from the nawaban CLI (`nawaban json ...`), the checkout docs/install.md puts at
// ~/nawaban; it runs in the space's folder without --db, so it finds the same board an agent
// working there does.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, HoverCard, Collapsible } from "gpui-base";
import { spaces, focused, agents, terminals, run, exec, theme, home, nextCommand, watchFolder } from "herdr";
import { projectFor, resolveLang, moveSelection, keyCommand, boardChanged, leadersView, itemLabel, decisionDate,
  WINDOW_WORDS } from "./logic.js";

const POLL_MS = 5000;      // re-read the board this often when it cannot be watched
const FALLBACK_MS = 60000; // and this often when it is, in case a change was missed
const GITHUB_MS = 60000;   // a GitHub board (`tracker: "github"`) is read from GitHub at most this often
const NARROW_W = 400;      // a narrower panel drops a spec's progress segments
const ICON = (name) => `mods/nawaban-board/${name}.svg`;
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`; // Herdr's shipped icons
const cli = () => `${home()}/nawaban/nawaban/cli.py`;

// The shown space's folder; home for a remote space (v1 reads this computer's board only).
function folder() {
  const space = spaces().find((s) => s.active);
  if (space?.machine) return home();
  return focused()?.cwd || space?.folder || home();
}

// The focused space's id.
const spaceId = () => focused()?.space ?? spaces().find((s) => s.active)?.id;

async function nawaban(args, cwd) {
  const r = await exec("python3", [cli(), ...args], { cwd });
  let out = null;
  try { out = JSON.parse(r.stdout || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim().split("\n").pop() || `exit ${r.code}`);
  return out;
}

const goTo = (terminal) => run("agent.focus", { terminal });

export default class NawabanBoard extends View {
  init(_props, cx) {
    this.board = null;          // `nawaban json board` of the space's project
    this.projectsOut = null;    // `nawaban json projects`, for the other projects' waiting count
    this.error = null;
    this.projects = new Map();  // folder -> its project (null: none), resolved once per folder
    this.dbs = new Map();       // folder -> the board file its CLI reads (null: unknown)
    this.watched = new Set();   // board files being watched
    this.github = new Map();    // folder -> its last GitHub board and when it was read
    this.unfolded = new Set();  // leaders whose 已关 row is open
    this.keys = [];             // the cards and items Enter can go to, in the order shown
    this.focusOf = new Map();   // their key -> the terminal they go to
    this.sel = null;            // the selected one's key (a card and an item can share a terminal)
    try { this.lang = localStorage.getItem("lang"); } catch { this.lang = null; }
    if (this.lang !== "zh" && this.lang !== "en") {
      this.lang = "en";
      cx.spawn(async (cx) => {
        let r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
        if (r?.code !== 0) r = await exec("sh", ["-c", 'printf %s "$LANG"']).catch(() => null);
        this.lang = resolveLang(null, r?.stdout);
        cx.notify();
      });
    }
    this.h = cx.focus_handle(); // the panel's keyboard: arrows, Enter, Esc
    this.refresh(cx);
    // Keys bound in keys.json to `nawaban-board.<command>`, `herdr-app do nawaban-board.<command>`,
    // and "focus" when `pane.go` gives the panel the keyboard.
    cx.spawn(async (cx) => { for (;;) { this.act(await nextCommand(), cx); cx.notify(); } });
    // A ticking clock costs nothing; a read starts a python process, so it waits for FALLBACK_MS
    // while the board is watched. Timers keep running while the panel is hidden.
    cx.timer.every(POLL_MS, (cx) => {
      if (this.watched.has(this.db) && Date.now() - this.readAt < FALLBACK_MS) return;
      this.refresh(cx);
    });
  }

  // One command, from a key in the panel or from nextCommand(): down, up, open, back, focus.
  act(cmd) {
    if (cmd === "focus") return this.h.focus();
    if (cmd === "back") { this.sel = null; return; }
    if (cmd === "open") { const f = this.focusOf.get(this.sel); if (f) goTo(f); return; }
    if (cmd === "down" || cmd === "up") this.sel = moveSelection(this.keys, this.sel, cmd === "down" ? 1 : -1);
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; } // read once more when this one ends
    const cwd = folder();
    this.loading = true;
    this.readAt = Date.now();
    this.context = cwd;
    cx.spawn(async (cx) => {
      try {
        const projects = await nawaban(["json", "projects"], cwd);
        if (!this.projects.has(cwd)) {
          const git = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
          // null with a CLI older than `json db`: the panel then polls every POLL_MS.
          this.dbs.set(cwd, await nawaban(["json", "db"], cwd).then((out) => out.db, () => null));
          this.projects.set(cwd, projectFor(git.code === 0 ? git.stdout : "", projects));
        }
        this.db = this.dbs.get(cwd);
        if (this.db) this.watch(this.db, cx);
        const project = this.projects.get(cwd);
        // A GitHub board is reused for GITHUB_MS from when its read started, whatever asked for the
        // read; a failed read counts too. ponytail: keyed by folder, so two folders of one repository
        // read GitHub apart; key by the git common dir if that doubles the reads.
        const gh = this.github.get(cwd), started = Date.now();
        let board = gh && started - gh.at < GITHUB_MS ? gh.board : null;
        if (!board) {
          if (gh) gh.at = started;
          board = await nawaban(["json", "board", ...(project ? ["--project", project] : [])], cwd);
          if (board.tracker === "github") this.github.set(cwd, { board, at: started });
        }
        if (folder() !== cwd) return; // the space changed meanwhile: the next refresh reads it
        Object.assign(this, { project, projectsOut: projects, board, error: null });
      } catch (e) {
        this.error = String(e?.message ?? e); // keep the last board shown
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Reads the board again when it changes, not on a clock: watches the board file's folder for as
  // long as the panel lives (one watch per board, whichever space shows it). A watch that fails
  // (Linux's directory limit) leaves the board to the POLL_MS timer.
  watch(db, cx) {
    if (this.watched.has(db)) return;
    this.watched.add(db);
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try { paths = await watchFolder(db.slice(0, db.lastIndexOf("/"))); } catch { this.watched.delete(db); return; }
        if (db === this.db && boardChanged(paths, db)) this.refresh(cx);
      }
    });
  }

  render(cx) {
    const all = agents(), space = spaceId(), mine = all.filter((a) => a.space === space);
    // Read again on a new space, and when a window comes, goes or changes state; not on its
    // title or seq, which change all the time while an agent works.
    const sig = mine.map((a) => `${a.address}:${a.status}`).join(",");
    if (folder() !== this.context || (this.sig != null && sig !== this.sig)) this.refresh(cx);
    this.sig = sig;
    const t = theme(), w = WINDOW_WORDS[this.lang];
    const now = Math.floor(Date.now() / 1000);
    const v = leadersView({ agents: all, terminals: terminals(), space, board: this.board, now, lang: this.lang,
      projects: this.projectsOut, project: this.project });
    this.keys = v.keys;
    this.focusOf = new Map([...v.waiting, ...v.groups.flatMap((g) => g.items)].map((x) => [x.key, x.focus]));
    const keyboard = this.h.is_focused();
    const note = this.error ? `${w.error}: ${this.error}` : !this.board ? w.loading
      : !v.waiting.length && !v.groups.length && !mine.length ? w.none : null;
    const sep = () => div().flex_none().h(1).mx(16).mt(12).bg(t.border);

    return v_flex().id("nawaban-board").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.canvas).border_1().border_color(t.border).text_color(t.foreground).text_size(13.5)
      .on_size_change((size, cx) => {
        const narrow = size.width < NARROW_W;
        if (narrow !== this.narrow) { this.narrow = narrow; cx.notify(); }
      })
      .track_focus(this.h).on_key_down((e, cx) => {
        const cmd = keyCommand(e);
        if (!cmd) return;
        this.act(cmd);
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.header(t, w, mine.length, v.otherWaiting))
      .child(v_flex().id("nawaban-body").flex_1().min_h(0).overflow_y_scrollbar().pb(16)
        .when(Boolean(note), (el) => el.child(div().flex_none().px(16).pb(8).text_size(12.5).text_color(t.muted).child(note)))
        .when(v.waiting.length > 0, (el) => el
          .child(div().flex_none().px(16).pt(2).pb(10).text_size(20).font_semibold().text_color(t.blocked).child(w.headline(v.waiting.length)))
          .child(v_flex().flex_none().px(12).gap(8).children(v.waiting.map((x, i) => this.card(x, i, keyboard, t, w)))))
        .children(v.groups.flatMap((g, i) => [...(i > 0 ? [sep()] : []), this.group(g, now, keyboard, t, w)]))
        .when(v.idle.count > 0, (el) => el.when(v.groups.length > 0, (el) => el.child(sep()))
          .child(div().flex_none().px(16).pt(12).text_size(12).text_color(t.dim).truncate()
            .child(w.idleRow(v.idle.count, v.idle.names)))));
  }

  // The project, then how many windows and what waits in other projects; the language menu.
  header(t, w, windows, elsewhere) {
    const name = this.project ?? spaces().find((s) => s.active)?.name ?? "";
    const more = Popover.new("nawaban-more-menu").anchor("top_right").open(Boolean(this.moreOpen))
      .on_open_change((open, cx) => { this.moreOpen = open; cx.notify(); })
      .trigger(h_flex().id("nawaban-more").size(24).flex_none().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(svg(ICON("more")).size(16).flex_none()))
      .content(this.menu("nawaban-lang", [
        { key: "zh", label: "中文", on: this.lang === "zh" },
        { key: "en", label: "English", on: this.lang === "en" },
      ], (lang) => {
        try { localStorage.setItem("lang", lang); } catch {}
        this.moreOpen = false;
        this.lang = lang;
      }, t, w.language));
    return h_flex().h(44).flex_none().pl(16).pr(8).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${w.windows(windows)} · ${w.elsewhere(elsewhere)}`))
      .child(more);
  }

  // A popup list of choices, the picked one checked; `title` is a dim heading over it.
  menu(id, items, pick, t, title) {
    return v_flex().id(id).w(220).mt(4).p(4).gap(1).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).text_size(13.5)
      .child(div().h(26).px(8).flex().items_center().text_size(12.5).text_color(t.muted).child(title))
      .children(items.map((x) => h_flex().id(`${id}-${x.key}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { pick(x.key); cx.notify(); })
        .child(div().size(16).flex_none().when(x.on, (el) => el.child(svg(CHROME("check")).size(16).text_color(t.foreground))))
        .child(div().flex_1().min_w(0).truncate().child(x.label))));
  }

  // A window waiting on you: its name and how long it has waited, the question (two lines at
  // most), then what it is working on and "去窗口 →". The whole card is the button; a waiting task
  // in no window of this space has nothing to go to, so no button. The selection is outlined.
  card(x, i, keyboard, t, w) {
    const can = x.focus != null, on = can && x.key === this.sel;
    return v_flex().id(`nawaban-card-${i}`).flex_none().p(12).rounded(8).bg(t.blocked + "26")
      .border_1().border_color(on ? (keyboard ? t.accent : t.blocked) : t.blocked + "00")
      .when(can, (el) => el.cursor_pointer().hover((s) => s.bg(t.blocked + "33"))
        .on_click((_e, cx) => { this.sel = x.key; goTo(x.focus); cx.notify(); }))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(x.name))
        .when(x.duration != null, (el) => el.child(div().flex_none().text_size(12.5).text_color(t.blocked).child(w.waited(x.duration)))))
      .child(div().mt(6).max_h(40).overflow_hidden().line_height("20px").child(x.question.replace(/\s+/g, " ").trim()))
      .child(h_flex().mt(10).gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(x.doing))
        .when(can, (el) => el.child(div().flex_none().px(10).py(5).rounded(6).bg(t.blocked)
          .text_size(12.5).font_semibold().text_color(t.canvas).child(w.go))));
  }

  // A leader: its window's name and 自己 n · 派出 m, its latest decision, then its items on a rail.
  group(g, now, keyboard, t, w) {
    return v_flex().flex_none().pt(16).pb(4)
      .child(h_flex().px(16).gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(g.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(w.counts(g.self, g.dispatched))))
      .child(g.decision
        ? h_flex().px(16).mt(3).mb(8).text_size(12).text_color(t.dim)
          .child(div().flex_none().text_color(t.muted).child(`${decisionDate(g.decision.at)} ${w.decided}`))
          .child(div().flex_1().min_w(0).truncate().child(`：${g.decision.verdict}`))
        : div().h(8))
      .children(g.items.map((x, i) => this.item(x, i === 0, i === g.items.length - 1, now, keyboard, t, w)))
      .when(g.closed.length > 0, (el) => el.child(this.closed(g, now, keyboard, t, w)));
  }

  // A group's closed issues, one dim "已关 n 个" row; a click shows them, as items, under it.
  closed(g, now, keyboard, t, w) {
    const open = this.unfolded.has(g.leader);
    return Collapsible.new().flex().flex_col().open(open)
      .child(h_flex().id(`nawaban-closed-${g.leader}`).h(26).px(16).gap(8).items_center().cursor_pointer()
        .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { open ? this.unfolded.delete(g.leader) : this.unfolded.add(g.leader); cx.notify(); })
        .child(h_flex().w(18).flex_none().justify_center().child(svg(CHROME(open ? "chevron-down" : "chevron-right")).size(12)))
        .child(div().flex_1().min_w(0).truncate().child(w.closed(g.closed.length))))
      .content(v_flex().children(g.closed.map((x, i) => this.item(x, i === 0, i === g.closed.length - 1, now, keyboard, t, w))));
  }

  // One item: a dot on the rail, its number, title (a spec: its segments and done/total), a child
  // terminal's Herdr name in small dim text, and its state; under a held one, who is on it (自己 or
  // worker; a child terminal, named already, skips it), its latest note (two lines) and 去窗口 →
  // while its window is there. With no such line, 去窗口 → ends the title row. Resting on an item
  // with a note shows the whole note. A child terminal waiting on you (waiting) is drawn as stopped
  // is, in the color that means "needs you"; an issue still moving with no window on it (pushing),
  // as a quiet grey ring.
  item(x, first, last, now, keyboard, t, w) {
    const amber = x.state === "stopped" || x.state === "waiting";
    const held = x.state === "current" || x.state === "pushing" || amber, on = x.key === this.sel;
    const railColor = x.state === "done" ? t.muted : t.border;
    const ring = (c) => div().size(12).flex_none().rounded_full().border_2().border_color(c).bg(t.canvas);
    const dot = x.state === "done" ? div().size(8).flex_none().rounded_full().bg(t.muted)
      : x.state === "todo" ? div().size(8).flex_none().rounded_full().border_2().border_color(t.dim).bg(t.canvas)
      : amber ? ring(t.blocked)
      : x.state === "pushing" ? ring(t.dim)
      : ring(t.working).flex().items_center().justify_center()
        .child(div().size(4).rounded_full().bg(t.working).loop("opacity", { from: 1, to: 0.25, period: 1600 }));
    const rail = v_flex().w(18).flex_none().items_center()
      .child(div().w(2).h(held ? 7 : 9).when(!first, (el) => el.bg(railColor)))
      .child(dot)
      .child(div().w(2).flex_1().min_h(4).when(!last, (el) => el.bg(railColor)));
    const segColor = { done: t.muted, current: t.working, stopped: t.blocked, todo: t.border };
    const stateColor = x.state === "current" ? t.working : amber ? t.blocked : t.dim;
    const said = x.gone ? (x.note ? `${w.gone} · ${x.note}` : w.gone) : x.note;
    const line = !held ? null : [x.name == null && x.who && w.who[x.who], said?.replace(/\s+/g, " ").trim()].filter(Boolean).join(" · ");
    const go = held && x.focus != null;
    const body = v_flex().flex_1().min_w(0)
      .child(h_flex().h(26).gap(6).items_center().text_size(12.5)
        .child(div().flex_none().text_size(11).text_color(t.dim).child(String(x.number)))
        .child(div().flex_1().min_w(0).truncate()
          .text_color(x.state === "done" || x.state === "todo" ? t.muted : t.foreground).child(x.title))
        .when(Boolean(x.spec), (el) => el
          .when(!this.narrow, (el) => el.child(h_flex().flex_none().gap(3).items_center()
            .children(x.spec.segments.map((s) => div().w(14).h(3).rounded(1).bg(segColor[s])))))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${x.spec.done}/${x.spec.total}`)))
        .when(x.name != null && x.name !== x.title, (el) => el.child(div().flex_none().max_w(96).truncate().text_size(11).text_color(t.dim).child(x.name)))
        .child(div().flex_none().text_size(11).text_color(stateColor).child(itemLabel(x, now, this.lang)))
        .when(go && !line, (el) => el.child(div().flex_none().text_size(12).text_color(t.foreground).child(w.go))))
      .when(Boolean(line), (el) => el.child(h_flex().gap(10).pb(8).items_end().text_size(12)
        .child(div().flex_1().min_w(0).max_h(36).overflow_hidden().line_height("18px").text_color(t.muted).child(line))
        .when(go, (el) => el.child(div().flex_none().text_color(t.foreground).child(w.go)))));
    const row = h_flex().id(`nawaban-item-${x.key}`).flex_none().px(16).gap(8).items_stretch().min_h(30)
      .when(on, (el) => el.bg(keyboard ? t.selected : t.hover))
      .when(x.focus != null, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.sel = x.key; goTo(x.focus); cx.notify(); }))
      .child(rail).child(body);
    if (!x.note) return row;
    return HoverCard.new(`nawaban-note-${x.key}`).anchor("bottom_left").trigger(row)
      .content(div().w(320).p(10).rounded(8).bg(t.popover).border_1().border_color(t.border)
        .text_size(12).line_height("18px").text_color(t.foreground).child(x.note));
  }
}
