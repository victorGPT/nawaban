// nawaban board, read-only: the windows (Herdr agent terminals) of the focused space, joined with
// the board of the project that space works in (leadersView in logic.js, DESIGN.md's line view).
// A card per window waiting on you, then one group per leader, its items on a rail in the order
// they arrived, the windows holding no task in one last row; a click goes to the window.
// Board data comes from the nawaban CLI (`nawaban json ...`), the checkout docs/install.md puts at
// ~/nawaban; it runs in the space's folder without --db, so it finds the same board an agent
// working there does.
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Popover, HoverCard, Collapsible, Accordion, AccordionItem, AccordionHeader, AccordionTrigger,
  AccordionPanel, Progress, ProgressTrack, ProgressIndicator } from "gpui-base";
import { spaces, focused, agents, terminals, run, exec, theme, home, nextCommand, watchFolder, props, closeOverlay } from "herdr";
import { projectFor, resolveLang, moveSelection, keyCommand, boardChanged, leadersView, itemLabel, decisionDate,
  WINDOW_WORDS, pendingView, okrView, OKR_WORDS } from "./logic.js";

const POLL_MS = 5000;      // re-read the board this often when it cannot be watched
const FALLBACK_MS = 60000; // and this often when it is, in case a change was missed
const GITHUB_MS = 60000;   // a GitHub board (`tracker: "github"`) is read from GitHub at most this often
const NARROW_W = 400;      // a narrower panel drops a spec's progress segments
const OKR_MS = 5000;       // `json okr` only reads the board and okr.toml: one slower than this is given up
const ICON = (name) => `mods/nawaban-board/${name}.svg`;
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`; // Herdr's shipped icons
const cli = () => `${home()}/nawaban/nawaban/cli.py`;

// Where the shown space's board is read: its machine (null: this computer) and folder there. A
// space on another machine (Herdr.app on one Mac driving another) is read on that machine through
// herdr-core, so the panel shows that machine's boards. `key` names the place in caches.
function place() {
  const space = spaces().find((s) => s.active);
  const on = space?.machine ?? null;
  const cwd = focused()?.cwd || space?.folder || (on ? undefined : home());
  return { on, cwd, key: `${on ?? ""}|${cwd ?? "~"}` };
}

// The focused space's id.
const spaceId = () => focused()?.space ?? spaces().find((s) => s.active)?.id;

// On another machine the CLI is that machine's ~/nawaban checkout, so $HOME is expanded there.
async function nawaban(args, at, timeout) {
  const r = at.on
    ? await exec("sh", ["-c", 'exec python3 "$HOME/nawaban/nawaban/cli.py" "$@"', "sh", ...args], { cwd: at.cwd, on: at.on, timeout })
    : await exec("python3", [cli(), ...args], { cwd: at.cwd, timeout });
  let out = null;
  try { out = JSON.parse(r.stdout || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim().split("\n").pop() || `exit ${r.code}`);
  return out;
}

const goTo = (terminal) => run("agent.focus", { terminal });
// A card or row goes to its window; with none, an issue opens on GitHub in the browser.
const go = (x) => (x.focus != null ? goTo(x.focus) : x.url ? exec("open", [x.url]).catch(() => null) : null);

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
    this.windowsOpen = false;   // a GitHub board's window groups, folded under its pending decisions
    this.okr = null;            // `nawaban json okr` of the space's repository (null: no OKR section)
    this.okrKey = null;         // the place this.okr was read for
    this.okrLoading = null;     // the place a `json okr` is in flight for
    this.okrWatch = null;       // the one okr.toml folder watched: { repo, stop }
    this.okrOpen = new Set();   // the Objectives unfolded
    this.keys = [];             // the cards and items Enter can go to, in the order shown
    this.focusOf = new Map();   // their key -> the card or row, which go() follows
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
    if (cmd === "open") { const x = this.focusOf.get(this.sel); if (x) go(x); return; }
    if (cmd === "down" || cmd === "up") this.sel = moveSelection(this.keys, this.sel, cmd === "down" ? 1 : -1);
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; } // read once more when this one ends
    const at = place(), key = at.key;
    this.refreshOkr(at, cx);
    this.loading = true;
    this.readAt = Date.now();
    this.context = key;
    cx.spawn(async (cx) => {
      try {
        const projects = await nawaban(["json", "projects"], at);
        if (!this.projects.has(key)) {
          const git = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: at.cwd, on: at.on });
          // null with a CLI older than `json db`, or on another machine (its files can't be watched
          // from here): the panel then polls every POLL_MS.
          this.dbs.set(key, at.on ? null : await nawaban(["json", "db"], at).then((out) => out.db, () => null));
          this.projects.set(key, projectFor(git.code === 0 ? git.stdout : "", projects));
        }
        this.db = this.dbs.get(key);
        if (this.db) this.watch(this.db, cx);
        const project = this.projects.get(key);
        // A GitHub board is reused for GITHUB_MS from when its read started, whatever asked for the
        // read; a failed read counts too. ponytail: keyed by place, so two folders of one repository
        // read GitHub apart; key by the git common dir if that doubles the reads.
        const gh = this.github.get(key), started = Date.now();
        let board = gh && started - gh.at < GITHUB_MS ? gh.board : null;
        if (!board) {
          if (gh) gh.at = started;
          board = await nawaban(["json", "board", ...(project ? ["--project", project] : [])], at);
          if (board.tracker === "github") this.github.set(key, { board, at: started });
        }
        if (place().key !== key) return; // the space changed meanwhile: the next refresh reads it
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

  // The OKR section's read, apart from the board's so a slow one never holds the board up: one in
  // flight per place, given up after OKR_MS, kept only if the space is still that place. No
  // okr.toml, or a CLI without `json okr`: null, no OKR section.
  refreshOkr(at, cx) {
    if (this.okrLoading === at.key) return;
    this.okrLoading = at.key;
    if (this.okrKey !== at.key) { this.okr = null; this.okrKey = at.key; } // another space's OKR is not this one's
    cx.spawn(async (cx) => {
      const okr = await nawaban(["json", "okr"], at, OKR_MS).catch(() => null);
      if (this.okrLoading === at.key) this.okrLoading = null;
      if (place().key !== at.key) return;
      this.okr = okr;
      if (okr?.repo && !at.on) this.watchOkr(okr.repo, cx);
      else { this.okrWatch?.stop(); this.okrWatch = null; }
      cx.notify();
    });
  }

  // Reads again when okr.toml changes (the board file's changes already do): watches its folder in
  // the repository's main checkout (`repo` is the main checkout's, from a worktree too). One watch
  // at a time: the shown repository's; another space's cancels it.
  watchOkr(repo, cx) {
    if (this.okrWatch?.repo === repo) return;
    this.okrWatch?.stop();
    const dir = `${repo}/docs/agents`;
    let pending = null, stopped = false;
    const me = { repo, stop: () => { stopped = true; pending?.cancel(); } };
    this.okrWatch = me;
    cx.spawn(async (cx) => {
      while (!stopped) {
        let paths;
        try { paths = await (pending = watchFolder(dir)); } catch { break; } // a watch that fails: the FALLBACK_MS reads
        if (!stopped && paths.some((p) => p === dir || p.endsWith("/okr.toml"))) this.refreshOkr(place(), cx);
      }
      if (this.okrWatch === me) this.okrWatch = null;
    });
  }

  render(cx) {
    const all = agents(), space = spaceId(), mine = all.filter((a) => a.space === space);
    // Read again on a new space, and when a window comes, goes or changes state; not on its
    // title or seq, which change all the time while an agent works.
    const sig = mine.map((a) => `${a.address}:${a.status}`).join(",");
    if (place().key !== this.context || (this.sig != null && sig !== this.sig)) this.refresh(cx);
    this.sig = sig;
    const t = theme(), w = WINDOW_WORDS[this.lang];
    const now = Math.floor(Date.now() / 1000);
    const v = leadersView({ agents: all, terminals: terminals(), space, board: this.board, now, lang: this.lang,
      projects: this.projectsOut, project: this.project });
    this.keys = v.keys;
    this.focusOf = new Map([...v.waiting, ...v.groups.flatMap((g) => g.items)].map((x) => [x.key, x]));
    const keyboard = this.h.is_focused();
    const note = this.error ? `${w.error}: ${this.error}` : !this.board ? w.loading
      : !v.waiting.length && !v.groups.length && !mine.length ? w.none : null;
    const okr = okrView(this.okr, this.lang);
    const sep = () => div().flex_none().h(1).mx(16).mt(12).bg(t.border);
    // The windows as before: waiting cards, leader groups, the idle row.
    const windows = (el) => el
      .when(v.waiting.length > 0, (el) => el
        .child(div().flex_none().px(16).pt(2).pb(10).text_size(20).font_semibold().text_color(t.blocked).child(w.headline(v.waiting.length)))
        .child(v_flex().flex_none().px(12).gap(8).children(v.waiting.map((x, i) => this.card(x, i, keyboard, t, w)))))
      .children(v.groups.flatMap((g, i) => [...(i > 0 ? [sep()] : []), this.group(g, now, keyboard, t, w)]))
      .when(v.idle.count > 0, (el) => el.when(v.groups.length > 0, (el) => el.child(sep()))
        .child(div().flex_none().px(16).pt(12).text_size(12).text_color(t.dim).truncate()
          .child(w.idleRow(v.idle.count, v.idle.names))));
    // A GitHub board: pending decisions on top, the windows folded under them.
    const github = this.board?.tracker === "github";
    if (github && !this.windowsOpen) this.keys = [];

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
        .when(Boolean(okr), (el) => this.okrSection(el, okr, sep, t, OKR_WORDS[this.lang]))
        .when(!github, windows)
        .when(github, (el) => this.pendingTop(el, pendingView(this.board), windows, v, t, w)));
  }

  // The OKR section above the windows: "OKR 15/23 达标 · 11-19 09:00 量", then "N 件要你盯" and an
  // amber card for each, then one Accordion item per Objective, closed until clicked.
  okrSection(el, v, sep, t, o) {
    return el
      .child(div().flex_none().px(16).pt(6).pb(4).text_size(11).text_color(t.dim).truncate().child(o.summary(v.met, v.total, v.measured)))
      .when(v.attention.length > 0, (el) => el
        .child(div().flex_none().px(16).pt(6).pb(10).text_size(20).font_semibold().text_color(t.blocked).child(o.headline(v.attention.length)))
        .child(v_flex().flex_none().px(12).gap(8).children(v.attention.map((a) => this.okrCard(a, t)))))
      .child(Accordion.new("nawaban-okr").flex_none().pt(6).children(v.objectives.map((ob, i) => this.objective(ob, i, t, o))))
      .child(sep());
  }

  // What the decision-maker has to watch: the KR (or Objective) and why, in amber; stuck and five
  // with their last readings drawn; the CLI's sentence; the Objective it belongs to.
  okrCard(a, t) {
    return v_flex().id(`nawaban-${a.key}`).flex_none().p(12).rounded(8).bg(t.blocked + "26")
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(a.title))
        .child(div().flex_none().text_size(12.5).text_color(t.blocked).child(a.label)))
      .when(Boolean(a.spark), (el) => el.child(this.spark(a.spark, a.target, t)))
      .when(Boolean(a.text), (el) => el.child(div().mt(6).max_h(40).overflow_hidden().line_height("20px").child(a.text)))
      .when(Boolean(a.objective), (el) => el.child(div().mt(8).truncate().text_size(12.5).text_color(t.dim).child(a.objective)));
  }

  // The last readings as a line (Path, in % of its box), the goal dashed, the values under it.
  spark(s, target, t) {
    const at = ([x, y]) => [`${x}%`, `${y}%`];
    const line = s.points.reduce((p, pt, i) => (i ? p.line_to(...at(pt)) : p.move_to(...at(pt))), PathBuilder.stroke(1.5)).build();
    const goal = s.goal == null ? null
      : PathBuilder.stroke(1).dash_array([3, 3]).move_to("0%", `${s.goal}%`).line_to("100%", `${s.goal}%`).build();
    return v_flex().mt(8).gap(2)
      .child(div().relative().h(32).w_full()
        .when(goal != null, (el) => el.child(window.paint_path(goal, t.muted).absolute().inset_0()))
        .child(window.paint_path(line, t.foreground).absolute().inset_0()))
      .child(h_flex().justify_between().text_size(11).text_color(t.muted).children(s.labels.map((l) => div().child(l))))
      .when(Boolean(target), (el) => el.child(div().text_size(11).text_color(t.muted).child(target)));
  }

  // An Objective: chevron, name, met/total (amber when something in it needs the decision-maker),
  // one segment per KR under it; open, its KR rows.
  objective(ob, i, t, o) {
    const open = this.okrOpen.has(ob.name);
    const seg = { met: t.muted, missed: t.foreground, stale: t.dim, untested: t.border };
    return AccordionItem.new().open(open)
      .header(AccordionHeader.new(AccordionTrigger.new(`nawaban-okr-o-${i}`)
        .on_change((on, cx) => { on ? this.okrOpen.add(ob.name) : this.okrOpen.delete(ob.name); cx.notify(); })
        .child(v_flex().px(16).py(6).gap(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .child(h_flex().gap(8).items_center()
            .child(h_flex().w(18).flex_none().justify_center().child(svg(CHROME(open ? "chevron-down" : "chevron-right")).size(12)))
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(ob.name))
            .child(div().flex_none().text_size(11).font_semibold().text_color(ob.attention ? t.blocked : t.muted).child(`${ob.met}/${ob.total}`)))
          .child(h_flex().ml(26).h(4).gap(2).children(ob.segments.map((s) => div().flex_1().h(4).rounded(1).bg(seg[s])))))))
      .panel(AccordionPanel.new().child(v_flex().px(8).pb(6).children(ob.krs.map((k, j) => this.kr(k, `${i}-${j}`, t, o)))));
  }

  // A KR: its dot, name (cut with an ellipsis), value; the target and as-of; a bar from 0 to the
  // value with the goal's tick. Resting on it opens a HoverCard with all of it.
  kr(k, key, t, o) {
    const dot = k.status === "met" ? div().size(8).rounded_full().bg(t.muted)
      : k.status === "missed" ? div().size(10).rounded_full().border_2().border_color(t.foreground)
      : div().size(8).rounded_full().border_2().border_color(k.status === "stale" ? t.dim : t.border);
    const tone = k.status === "missed" ? t.foreground : k.status === "met" ? t.muted : t.dim;
    const row = v_flex().id(`nawaban-kr-${key}`).flex_none().px(8).py(6).gap(3).rounded(6).hover((s) => s.bg(t.hover))
      .child(h_flex().gap(6).items_center().text_size(12.5)
        .child(h_flex().w(18).flex_none().justify_center().child(dot))
        .child(div().flex_1().min_w(0).truncate().child(k.name))
        .child(div().flex_none().text_size(12).font_semibold().text_color(tone)
          .child(k.status === "stale" ? `${k.value} · ${o.status.stale}` : k.value)))
      .child(div().ml(24).truncate().text_size(11).text_color(t.dim)
        .child([`${o.target} ${k.target}`, k.as_of?.slice(5, 10)].filter(Boolean).join(" · ")))
      .when(k.fill != null, (el) => el.child(Progress.new(`nawaban-kr-bar-${key}`).value(k.fill).ml(24).mt(2)
        .child(ProgressTrack.new().relative().h(3).w_full().rounded(2).bg(t.border)
          .child(ProgressIndicator.new().h(3).w(`${k.fill}%`).rounded(2).bg(tone))
          .when(k.tick != null, (el) => el.child(div().absolute().left(`${k.tick}%`).top(-3).w(2).h(9).bg(t.foreground))))));
    const facts = [[o.value, k.value], [o.target, k.target], [o.asOf, k.as_of], [o.source, k.source], [o.trendLabel, k.trend],
      ...(k.missed_rounds > 0 ? [["", o.rounds(k.missed_rounds)]] : []), ...(k.wait ? [[o.wait, k.wait]] : [])].filter(([, v]) => v);
    return HoverCard.new(`nawaban-kr-card-${key}`).anchor("bottom_left").trigger(row)
      .content(v_flex().w(280).p(10).gap(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
        .text_size(12).line_height("18px").text_color(t.foreground)
        .child(div().font_semibold().child(k.name))
        .children(facts.map(([label, v]) => h_flex().gap(8).items_start()
          .child(div().w(40).flex_none().text_color(t.dim).child(label))
          .child(div().flex_1().min_w(0).child(String(v))))));
  }

  // A GitHub board's top: 待决 N, a row per pending decision (a click opens its issue on GitHub); the window groups folded.
  pendingTop(el, pending, windows, v, t, w) {
    const count = v.waiting.length + v.groups.length + (v.idle.count > 0 ? 1 : 0);
    return el
      .when(pending.length > 0, (el) => el
        .child(div().flex_none().px(16).pt(14).pb(6).text_size(12).font_semibold().text_color(t.muted).child(w.pending(pending.length)))
        .child(v_flex().flex_none().px(8).gap(4).children(pending.map((p) => h_flex().id(`nawaban-pending-${p.id}`).flex_none()
          .px(8).py(8).gap(8).items_center().rounded(8).bg(t.blocked + "1a").cursor_pointer().hover((s) => s.bg(t.blocked + "26"))
          .on_click(() => { if (p.url) exec("open", [p.url]).catch(() => null); })
          .child(div().flex_none().text_size(12).font_semibold().text_color(t.blocked).child(p.id))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(p.title))))))
      .child(Collapsible.new().flex().flex_col().open(Boolean(this.windowsOpen))
        .child(h_flex().id("nawaban-windows").h(28).mt(10).px(16).gap(8).items_center().cursor_pointer()
          .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.windowsOpen = !this.windowsOpen; cx.notify(); })
          .child(h_flex().w(18).flex_none().justify_center().child(svg(CHROME(this.windowsOpen ? "chevron-down" : "chevron-right")).size(12)))
          .child(div().flex_1().min_w(0).truncate().child(w.windowsFold(count))))
        .content(windows(v_flex())));
  }

  // The project, then how many windows and what waits in other projects; the language menu; opened
  // as a window (any layout, `mod.open:nawaban-board`), a ✕ that closes it.
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
      .child(more)
      .when(Boolean(props()?.overlay), (el) => el.child(h_flex().id("nawaban-close").size(24).flex_none().items_center()
        .justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => closeOverlay(props().overlay))
        .child("✕")));
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
    const can = x.focus != null || Boolean(x.url), on = can && x.key === this.sel;
    return v_flex().id(`nawaban-card-${i}`).flex_none().p(12).rounded(8).bg(t.blocked + "26")
      .border_1().border_color(on ? (keyboard ? t.accent : t.blocked) : t.blocked + "00")
      .when(can, (el) => el.cursor_pointer().hover((s) => s.bg(t.blocked + "33"))
        .on_click((_e, cx) => { this.sel = x.key; go(x); cx.notify(); }))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(x.name))
        .when(x.duration != null, (el) => el.child(div().flex_none().text_size(12.5).text_color(t.blocked).child(w.waited(x.duration)))))
      .child(div().mt(6).max_h(40).overflow_hidden().line_height("20px").child(x.question.replace(/\s+/g, " ").trim()))
      .child(h_flex().mt(10).gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(x.doing))
        .when(can, (el) => el.child(div().flex_none().px(10).py(5).rounded(6).bg(t.blocked)
          .text_size(12.5).font_semibold().text_color(t.canvas).child(x.focus != null ? w.go : w.issue))));
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
    const there = held && x.focus != null;
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
        .when(there && !line, (el) => el.child(div().flex_none().text_size(12).text_color(t.foreground).child(w.go))))
      .when(Boolean(line), (el) => el.child(h_flex().gap(10).pb(8).items_end().text_size(12)
        .child(div().flex_1().min_w(0).max_h(36).overflow_hidden().line_height("18px").text_color(t.muted).child(line))
        .when(there, (el) => el.child(div().flex_none().text_color(t.foreground).child(w.go)))));
    const row = h_flex().id(`nawaban-item-${x.key}`).flex_none().px(16).gap(8).items_stretch().min_h(30)
      .when(on, (el) => el.bg(keyboard ? t.selected : t.hover))
      .when(x.focus != null || Boolean(x.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.sel = x.key; go(x); cx.notify(); }))
      .child(rail).child(body);
    if (!x.note) return row;
    return HoverCard.new(`nawaban-note-${x.key}`).anchor("bottom_left").trigger(row)
      .content(div().w(320).p(10).rounded(8).bg(t.popover).border_1().border_color(t.border)
        .text_size(12).line_height("18px").text_color(t.foreground).child(x.note));
  }
}
