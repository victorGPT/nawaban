import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Popover, HoverCard, Collapsible, Accordion, AccordionItem, AccordionHeader, AccordionTrigger,
  AccordionPanel, Progress, ProgressTrack, ProgressIndicator } from "gpui-base";
import { spaces, focused, agents, terminals, run, exec, theme, home, nextCommand, watchFolder, props, closeOverlay } from "herdr";
import { projectFor, repoName, cliFor, resolveLang, moveSelection, keyCommand, boardChanged, okrChanged, folderOf, canGo, leadersView,
  itemLabel, decisionDate, isoMonthDay, WINDOW_WORDS, pendingView, okrView, OKR_WORDS, OKR_FOLDER_IN_REPO, okrReadingOfFailure, hasNoObjective,
  TASKS_FOLD_KEY, tasksFoldView, keysWithTasksFold } from "./logic.js";

const UNWATCHED_BOARD_REREAD_MS = 5000;
const WATCHED_BOARD_MISSED_CHANGE_REREAD_MS = 60000;
const GITHUB_BOARD_REUSED_FOR_MS = 60000;
const NARROWEST_WITH_SPEC_SEGMENTS = 400;
const OKR_READ_GIVEN_UP_AFTER_MS = 5000;
const ICON = (name) => "mods/nawaban-board/" + name + ".svg";
const HERDR_ICON = (name) => "mods/workspace-chrome/" + name + ".svg";
const CLI = { board: () => ["node", home() + "/nawaban/board/src/cli.ts"], old: () => ["python3", home() + "/nawaban/nawaban/cli.py"] };
const OLD_CLI_ON_ANOTHER_MACHINE = 'exec python3 "$HOME/nawaban/nawaban/cli.py" "$@"';

const TINT = { clear: "00", faint: "1a", soft: "26", strong: "33" };
const MAX_LINES = 2;
const CARD_LINE_HEIGHT = 20;
const SMALL_LINE_HEIGHT = 18;
const GUTTER_W = 18;
const ICON_BUTTON = 24;
const KR_ROW_GAP = 6;
const OBJECTIVE_ROW_GAP = 8;
const SPARK_H = 32;
const SPARK_STROKE = 1.5;
const GOAL_STROKE = 1;
const GOAL_DASH = [3, 3];
const WORKING_PULSE = { from: 1, to: 0.25, period: 1600 };

const clampLines = (el, lineHeight) => el.max_h(MAX_LINES * lineHeight).overflow_hidden().line_height(lineHeight + "px");
const oneLine = (text) => text.replace(/\s+/g, " ").trim();
const chevron = (open) => h_flex().w(GUTTER_W).flex_none().justify_center()
  .child(svg(HERDR_ICON(open ? "chevron-down" : "chevron-right")).size(12));

function place() {
  const space = spaces().find((s) => s.active);
  const on = space?.machine ?? null;
  const cwd = focused()?.cwd || space?.folder || (on ? undefined : home());
  return { on, cwd, key: (on ?? "") + "|" + (cwd ?? "~") };
}
const placeChangedFrom = (key) => place().key !== key;

const spaceId = () => focused()?.space ?? spaces().find((s) => s.active)?.id;

const runCli = (args, at, timeout, via) => {
  if (at.on) return exec("sh", ["-c", OLD_CLI_ON_ANOTHER_MACHINE, "sh", ...args], { cwd: at.cwd, on: at.on, timeout });
  const [cmd, path] = CLI[via]();
  return exec(cmd, [path, ...args], { cwd: at.cwd, timeout });
};

const parseJsonOrNull = (text) => {
  try { return JSON.parse(text || "null"); } catch { return null; }
};
const lastLine = (text) => text?.trim().split("\n").pop();

async function nawaban(args, at, timeout, via = "old") {
  const r = await runCli(args, at, timeout, via);
  const out = parseJsonOrNull(r.stdout);
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || lastLine(r.stderr) || "exit " + r.code);
  return out;
}

const goTo = (terminal) => run("agent.focus", { terminal });
const openInBrowser = (url) => exec("open", [url]).catch(() => null);
const go = (x) => (x.focus != null ? goTo(x.focus) : x.url ? openInBrowser(x.url) : null);

const readSavedLang = () => {
  try { return localStorage.getItem("lang"); } catch { return null; }
};
const saveLang = (lang) => {
  try { localStorage.setItem("lang", lang); } catch {}
};
async function systemLanguage() {
  const apple = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
  if (apple?.code === 0) return apple.stdout;
  const env = await exec("sh", ["-c", 'printf %s "$LANG"']).catch(() => null);
  return env?.stdout;
}

const windowStatesOf = (windows) => windows.map((a) => a.address + ":" + a.status).join(",");

export default class NawabanBoard extends View {
  init(_props, cx) {
    this.board = null;
    this.projectsList = null;
    this.error = null;
    this.projectOfPlace = new Map();
    this.gitDirOfPlace = new Map();
    this.boardFileOfPlace = new Map();
    this.watchedBoardFiles = new Set();
    this.githubBoardOfPlace = new Map();
    this.unfolded = new Set();
    this.tasksOpen = false;
    this.okr = null;
    this.okrPlace = null;
    this.okrFlight = new Map();
    this.okrGen = 0;
    this.okrTomlWatch = null;
    this.okrOpen = new Set();
    this.keys = [];
    this.selectableByKey = new Map();
    this.selectedKey = null;
    this.lang = readSavedLang();
    if (this.lang !== "zh" && this.lang !== "en") this.followSystemLanguage(cx);
    this.keyboard = cx.focus_handle();
    this.refresh(cx);
    this.obeyCommands(cx);
    cx.timer.every(UNWATCHED_BOARD_REREAD_MS, (cx) => {
      if (this.watchKeepsBoardFresh()) return;
      this.refresh(cx);
    });
  }

  followSystemLanguage(cx) {
    this.lang = "en";
    cx.spawn(async (cx) => {
      this.lang = resolveLang(null, await systemLanguage());
      cx.notify();
    });
  }

  obeyCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        this.act(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  watchKeepsBoardFresh() {
    return this.watchedBoardFiles.has(this.db) && Date.now() - this.lastReadAt < WATCHED_BOARD_MISSED_CHANGE_REREAD_MS;
  }

  act(cmd) {
    if (cmd === "focus") return this.keyboard.focus();
    if (cmd === "back") { this.selectedKey = null; return; }
    if (cmd === "open") return this.openSelected();
    if (cmd === "down" || cmd === "up") this.selectedKey = moveSelection(this.keys, this.selectedKey, cmd === "down" ? 1 : -1);
  }

  openSelected() {
    if (this.selectedKey === TASKS_FOLD_KEY) { this.tasksOpen = !this.tasksOpen; return; }
    const x = this.selectableByKey.get(this.selectedKey);
    if (x) go(x);
  }

  refresh(cx) {
    if (this.reading) { this.readAgainWhenDone = true; return; }
    const at = place(), key = at.key;
    this.refreshOkr(at, cx);
    this.reading = true;
    this.lastReadAt = Date.now();
    this.placeShown = key;
    cx.spawn(async (cx) => {
      try {
        const git = await this.gitOf(at), via = cliFor(repoName(git), at.on);
        const projects = await nawaban(["json", "projects"], at, undefined, via);
        if (!this.projectOfPlace.has(key)) await this.learnPlace(at, git, projects, via);
        this.db = this.boardFileOfPlace.get(key);
        if (this.db) this.watch(this.db, cx);
        const project = this.projectOfPlace.get(key);
        const board = await this.boardReusingGithubWithinWindow(at, project, via);
        if (placeChangedFrom(key)) return;
        Object.assign(this, { project, projectsList: projects, board, error: null });
      } catch (e) {
        this.keepLastBoardShowing(e);
      } finally {
        this.endRead(cx);
      }
    });
  }

  async learnPlace(at, git, projects, via) {
    this.boardFileOfPlace.set(at.key, at.on ? null : await nawaban(["json", "db"], at, undefined, via).then((out) => out.db, () => null));
    this.projectOfPlace.set(at.key, projectFor(git, projects));
  }

  async boardReusingGithubWithinWindow(at, project, via) {
    const cached = this.githubBoardOfPlace.get(at.key), started = Date.now();
    if (cached && started - cached.at < GITHUB_BOARD_REUSED_FOR_MS) return cached.board;
    if (cached) cached.at = started;
    const board = await nawaban(["json", "board", ...(project ? ["--project", project] : [])], at, undefined, via);
    if (board.tracker === "github") this.githubBoardOfPlace.set(at.key, { board, at: started });
    return board;
  }

  keepLastBoardShowing(e) {
    this.error = String(e?.message ?? e);
  }

  endRead(cx) {
    this.reading = false;
    cx.notify();
    if (this.readAgainWhenDone) { this.readAgainWhenDone = false; this.refresh(cx); }
  }

  gitOf(at) {
    if (!this.gitDirOfPlace.has(at.key)) {
      this.gitDirOfPlace.set(at.key, exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: at.cwd, on: at.on })
        .then((r) => (r.code === 0 ? r.stdout : ""), () => ""));
    }
    return this.gitDirOfPlace.get(at.key);
  }

  watch(db, cx) {
    if (this.watchedBoardFiles.has(db)) return;
    this.watchedBoardFiles.add(db);
    cx.spawn(async (cx) => {
      for (;;) {
        let paths;
        try { paths = await watchFolder(folderOf(db)); } catch { this.watchedBoardFiles.delete(db); return; }
        if (db === this.db && boardChanged(paths, db)) this.refresh(cx);
      }
    });
  }

  forgetOkrOfAnotherPlace(at) {
    if (this.okrPlace === at.key) return;
    this.okr = null;
    this.okrPlace = at.key;
  }

  isNewestOkrRead(at, gen) {
    return this.okrFlight.get(at.key) === gen;
  }

  refreshOkr(at, cx) {
    this.forgetOkrOfAnotherPlace(at);
    if (this.okrFlight.has(at.key)) return;
    const gen = ++this.okrGen;
    this.okrFlight.set(at.key, gen);
    cx.spawn(async (cx) => {
      const via = cliFor(repoName(await this.gitOf(at)), at.on);
      const okr = await nawaban(["json", "okr"], at, OKR_READ_GIVEN_UP_AFTER_MS, via).catch(okrReadingOfFailure);
      if (!this.isNewestOkrRead(at, gen)) return;
      this.okrFlight.delete(at.key);
      if (placeChangedFrom(at.key)) return;
      this.okr = okr;
      this.watchOkrOf(okr, at, cx);
      cx.notify();
    });
  }

  watchOkrOf(okr, at, cx) {
    if (okr?.repo && !at.on) return this.watchOkr(okr.repo, cx);
    this.okrTomlWatch?.stop();
    this.okrTomlWatch = null;
  }

  watchOkr(repo, cx) {
    if (this.okrTomlWatch?.repo === repo) return;
    this.okrTomlWatch?.stop();
    const dir = repo + "/" + OKR_FOLDER_IN_REPO;
    let pending = null, stopped = false;
    const me = { repo, stop: () => { stopped = true; pending?.cancel(); } };
    this.okrTomlWatch = me;
    cx.spawn(async (cx) => {
      while (!stopped) {
        let paths;
        try { paths = await (pending = watchFolder(dir)); } catch { break; }
        if (!stopped && okrChanged(paths, dir)) this.refreshOkr(place(), cx);
      }
      if (this.okrTomlWatch === me) this.okrTomlWatch = null;
    });
  }

  rereadOnNewSpaceOrWindowState(windows, cx) {
    const states = windowStatesOf(windows);
    const windowChanged = this.windowStatesSeen != null && states !== this.windowStatesSeen;
    if (placeChangedFrom(this.placeShown) || windowChanged) this.refresh(cx);
    this.windowStatesSeen = states;
  }

  statusNote(v, windows, w) {
    if (this.error) return w.error + ": " + this.error;
    if (!this.board) return w.loading;
    const nothingToShow = !v.waiting.length && !v.groups.length && !windows.length;
    return nothingToShow ? w.none : null;
  }

  rememberSelectable(v) {
    this.keys = this.board ? keysWithTasksFold(v.keys, this.tasksOpen) : v.keys;
    this.selectableByKey = new Map([...v.waiting, ...v.groups.flatMap((g) => g.items)].map((x) => [x.key, x]));
  }

  render(cx) {
    const all = agents(), space = spaceId(), mine = all.filter((a) => a.space === space);
    this.rereadOnNewSpaceOrWindowState(mine, cx);
    const t = theme(), w = WINDOW_WORDS[this.lang];
    const now = Math.floor(Date.now() / 1000);
    const v = leadersView({ agents: all, terminals: terminals(), space, board: this.board, now, lang: this.lang,
      projects: this.projectsList, project: this.project });
    const github = this.board?.tracker === "github";
    this.rememberSelectable(v);
    const keyboard = this.keyboard.is_focused();
    const note = this.statusNote(v, mine, w);
    const okr = okrView(this.okr, this.lang);
    const sep = () => div().flex_none().h(1).mx(16).mt(12).bg(t.border);
    const cards = (el) => this.waitingCards(el, v, keyboard, t, w);
    const groups = (el) => this.windowGroups(el, v, sep, now, keyboard, t, w);

    return v_flex().id("nawaban-board").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.canvas).border_1().border_color(t.border).text_color(t.foreground).text_size(13.5)
      .on_size_change((size, cx) => this.noteWidth(size, cx))
      .track_focus(this.keyboard).on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t, w, mine.length, v.otherWaiting))
      .child(v_flex().id("nawaban-body").flex_1().min_h(0).overflow_y_scrollbar().pb(16)
        .when(Boolean(note), (el) => el.child(div().flex_none().px(16).pb(8).text_size(12.5).text_color(t.muted).child(note)))
        .when(true, cards)
        .when(github, (el) => this.pendingRows(el, pendingView(this.board), t, w))
        .when(Boolean(okr), (el) => this.okrSection(el, okr, sep, t, OKR_WORDS[this.lang]))
        .when(hasNoObjective(this.okr), (el) => this.noObjectiveRow(el, sep, t, OKR_WORDS[this.lang]))
        .when(Boolean(this.board), (el) => this.tasksFold(el, groups, v, keyboard, t, w)));
  }

  noteWidth(size, cx) {
    const narrow = size.width < NARROWEST_WITH_SPEC_SEGMENTS;
    if (narrow === this.narrow) return;
    this.narrow = narrow;
    cx.notify();
  }

  onKey(e, cx) {
    const cmd = keyCommand(e);
    if (!cmd) return;
    this.act(cmd);
    cx.stop_propagation();
    cx.notify();
  }

  waitingCards(el, v, keyboard, t, w) {
    return el.when(v.waiting.length > 0, (el) => el
      .child(div().flex_none().px(16).pt(2).pb(10).text_size(20).font_semibold().text_color(t.blocked).child(w.headline(v.waiting.length)))
      .child(v_flex().flex_none().px(12).gap(8).children(v.waiting.map((x, i) => this.card(x, i, keyboard, t, w)))));
  }

  windowGroups(el, v, sep, now, keyboard, t, w) {
    return el
      .children(v.groups.flatMap((g, i) => [...(i > 0 ? [sep()] : []), this.group(g, now, keyboard, t, w)]))
      .when(v.idle.count > 0, (el) => el.when(v.groups.length > 0, (el) => el.child(sep()))
        .child(div().flex_none().px(16).pt(12).text_size(12).text_color(t.dim).truncate()
          .child(w.idleRow(v.idle.count, v.idle.names))));
  }

  okrSection(el, v, sep, t, o) {
    return el
      .child(div().flex_none().px(16).pt(6).pb(4).text_size(11).text_color(t.dim).truncate().child(o.summary(v.met, v.total, v.measured)))
      .when(v.attention.length > 0, (el) => el
        .child(div().flex_none().px(16).pt(6).pb(10).text_size(20).font_semibold().text_color(t.blocked).child(o.headline(v.attention.length)))
        .child(v_flex().flex_none().px(12).gap(8).children(v.attention.map((a) => this.okrCard(a, t, o)))))
      .child(Accordion.new("nawaban-okr").flex_none().pt(6).children(v.objectives.map((ob, i) => this.objective(ob, i, t, o))))
      .child(sep());
  }

  noObjectiveRow(el, sep, t, o) {
    return el
      .child(div().flex_none().px(16).pt(6).pb(4).text_size(12).text_color(t.dim).truncate().child(o.noObjective))
      .child(sep());
  }

  okrCard(a, t, o) {
    return v_flex().id("nawaban-" + a.key).flex_none().p(12).rounded(8).bg(t.blocked + TINT.soft)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(a.title))
        .child(div().flex_none().text_size(12.5).text_color(t.blocked).child(a.label)))
      .when(Boolean(a.spark), (el) => el.child(this.spark(a.spark, a.target, t)))
      .when(Boolean(a.text), (el) => el.child(clampLines(div().mt(6), CARD_LINE_HEIGHT).child(a.text)))
      .when(Boolean(a.objective), (el) => el.child(div().mt(8).truncate().text_size(12.5).text_color(t.dim).child(a.objective)))
      .when(Boolean(a.krs), (el) => el.child(clampLines(div().mt(8), SMALL_LINE_HEIGHT).text_size(12.5).text_color(t.dim).child(a.krs.join(o.list))));
  }

  spark(s, target, t) {
    const at = ([x, y]) => [x + "%", y + "%"];
    const line = s.points.reduce((p, pt, i) => (i ? p.line_to(...at(pt)) : p.move_to(...at(pt))), PathBuilder.stroke(SPARK_STROKE)).build();
    const goal = s.goal == null ? null
      : PathBuilder.stroke(GOAL_STROKE).dash_array(GOAL_DASH).move_to("0%", s.goal + "%").line_to("100%", s.goal + "%").build();
    return v_flex().mt(8).gap(2)
      .child(div().relative().h(SPARK_H).w_full()
        .when(goal != null, (el) => el.child(window.paint_path(goal, t.muted).absolute().inset_0()))
        .child(window.paint_path(line, t.foreground).absolute().inset_0()))
      .child(h_flex().justify_between().text_size(11).text_color(t.muted).children(s.labels.map((l) => div().child(l))))
      .when(Boolean(target), (el) => el.child(div().text_size(11).text_color(t.muted).child(target)));
  }

  toggleObjective(name, on, cx) {
    on ? this.okrOpen.add(name) : this.okrOpen.delete(name);
    cx.notify();
  }

  objective(ob, i, t, o) {
    const open = this.okrOpen.has(ob.name);
    const seg = { met: t.muted, missed: t.foreground, stale: t.dim, untested: t.border };
    return AccordionItem.new().open(open)
      .header(AccordionHeader.new(AccordionTrigger.new("nawaban-okr-o-" + i)
        .on_change((on, cx) => this.toggleObjective(ob.name, on, cx))
        .child(v_flex().px(16).py(6).gap(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .child(h_flex().gap(OBJECTIVE_ROW_GAP).items_center()
            .child(chevron(open))
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(ob.name))
            .when(Boolean(ob.impacts), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ob.impacts)))
            .child(div().flex_none().text_size(11).font_semibold().text_color(ob.attention ? t.blocked : t.muted).child(ob.met + "/" + ob.total)))
          .child(h_flex().ml(GUTTER_W + OBJECTIVE_ROW_GAP).h(4).gap(2).children(ob.segments.map((s) => div().flex_1().h(4).rounded(1).bg(seg[s])))))))
      .panel(AccordionPanel.new().child(v_flex().px(8).pb(6).children(ob.krs.map((k, j) => this.kr(k, i + "-" + j, t, o)))));
  }

  krDot(k, t) {
    if (k.status === "met") return div().size(8).rounded_full().bg(t.muted);
    if (k.status === "missed") return div().size(10).rounded_full().border_2().border_color(t.foreground);
    return div().size(8).rounded_full().border_2().border_color(k.status === "stale" ? t.dim : t.border);
  }

  krTone(k, t) {
    return k.status === "missed" ? t.foreground : k.status === "met" ? t.muted : t.dim;
  }

  krBar(el, k, key, tone, t) {
    const indent = GUTTER_W + KR_ROW_GAP;
    return el.child(Progress.new("nawaban-kr-bar-" + key).value(k.fill).ml(indent).mt(2)
      .child(ProgressTrack.new().relative().h(3).w_full().rounded(2).bg(t.border)
        .child(ProgressIndicator.new().h(3).w(k.fill + "%").rounded(2).bg(tone))
        .when(k.tick != null, (el) => el.child(div().absolute().left(k.tick + "%").top(-3).w(2).h(9).bg(t.foreground)))));
  }

  krFacts(k, o) {
    return [[o.value, k.value], [o.target, k.target], [o.asOf, k.as_of], [o.source, k.source], [o.trendLabel, k.trend],
      ...(k.missed_rounds > 0 ? [["", o.rounds(k.missed_rounds)]] : []), ...(k.wait ? [[o.wait, k.wait]] : [])].filter(([, v]) => v);
  }

  kr(k, key, t, o) {
    const tone = this.krTone(k, t), indent = GUTTER_W + KR_ROW_GAP;
    const row = v_flex().id("nawaban-kr-" + key).flex_none().px(8).py(6).gap(3).rounded(6).hover((s) => s.bg(t.hover))
      .child(h_flex().gap(KR_ROW_GAP).items_center().text_size(12.5)
        .child(h_flex().w(GUTTER_W).flex_none().justify_center().child(this.krDot(k, t)))
        .child(div().flex_1().min_w(0).truncate().child(k.name))
        .child(div().flex_none().text_size(12).font_semibold().text_color(tone)
          .child(k.status === "stale" ? k.value + " · " + o.status.stale : k.value)))
      .child(div().ml(indent).truncate().text_size(11).text_color(t.dim)
        .child([o.target + " " + k.target, k.as_of && isoMonthDay(k.as_of)].filter(Boolean).join(" · ")))
      .when(Boolean(k.mismatch), (el) => el.child(div().ml(indent).truncate().text_size(11).text_color(t.foreground).child(k.mismatch)))
      .when(k.fill != null, (el) => this.krBar(el, k, key, tone, t));
    return HoverCard.new("nawaban-kr-card-" + key).anchor("bottom_left").trigger(row)
      .content(v_flex().w(280).p(10).gap(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
        .text_size(12).line_height(SMALL_LINE_HEIGHT + "px").text_color(t.foreground)
        .child(div().font_semibold().child(k.name))
        .children(this.krFacts(k, o).map(([label, v]) => h_flex().gap(8).items_start()
          .child(div().w(40).flex_none().text_color(t.dim).child(label))
          .child(div().flex_1().min_w(0).child(String(v))))));
  }

  pendingRows(el, pending, t, w) {
    return el
      .when(pending.length > 0, (el) => el
        .child(div().flex_none().px(16).pt(14).pb(6).text_size(12).font_semibold().text_color(t.muted).child(w.pending(pending.length)))
        .child(v_flex().flex_none().px(8).gap(4).children(pending.map((p) => h_flex().id("nawaban-pending-" + p.id).flex_none()
          .px(8).py(8).gap(8).items_center().rounded(8).bg(t.blocked + TINT.faint).cursor_pointer().hover((s) => s.bg(t.blocked + TINT.soft))
          .on_click(() => { if (p.url) openInBrowser(p.url); })
          .child(div().flex_none().text_size(12).font_semibold().text_color(t.blocked).child(p.id))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(p.title))))));
  }

  toggleTasks(cx) {
    this.selectedKey = TASKS_FOLD_KEY;
    this.tasksOpen = !this.tasksOpen;
    cx.notify();
  }

  tasksFold(el, groups, v, keyboard, t, w) {
    const selected = this.selectedKey === TASKS_FOLD_KEY;
    return el
      .child(Collapsible.new().flex().flex_col().open(this.tasksOpen)
        .child(h_flex().id("nawaban-tasks").h(28).mt(10).px(16).gap(8).items_center().cursor_pointer()
          .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .when(selected, (el) => el.bg(keyboard ? t.selected : t.hover))
          .on_click((_e, cx) => this.toggleTasks(cx))
          .child(chevron(this.tasksOpen))
          .child(div().flex_1().min_w(0).truncate().child(w.tasksFold(tasksFoldView(v)))))
        .content(groups(v_flex())));
  }

  pickLang(lang) {
    saveLang(lang);
    this.moreOpen = false;
    this.lang = lang;
  }

  languageMenu(t, w) {
    return Popover.new("nawaban-more-menu").anchor("top_right").open(Boolean(this.moreOpen))
      .on_open_change((open, cx) => { this.moreOpen = open; cx.notify(); })
      .trigger(h_flex().id("nawaban-more").size(ICON_BUTTON).flex_none().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(svg(ICON("more")).size(16).flex_none()))
      .content(this.menu("nawaban-lang", [
        { key: "zh", label: "中文", on: this.lang === "zh" },
        { key: "en", label: "English", on: this.lang === "en" },
      ], (lang) => this.pickLang(lang), t, w.language));
  }

  closeButton(el, t) {
    return el.child(h_flex().id("nawaban-close").size(ICON_BUTTON).flex_none().items_center()
      .justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => closeOverlay(props().overlay))
      .child("✕"));
  }

  header(t, w, windows, elsewhere) {
    const name = this.project ?? spaces().find((s) => s.active)?.name ?? "";
    const openedAsOverlay = Boolean(props()?.overlay);
    return h_flex().h(44).flex_none().pl(16).pr(8).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(w.windows(windows) + " · " + w.elsewhere(elsewhere)))
      .child(this.languageMenu(t, w))
      .when(openedAsOverlay, (el) => this.closeButton(el, t));
  }

  menu(id, items, pick, t, title) {
    return v_flex().id(id).w(220).mt(4).p(4).gap(1).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).text_size(13.5)
      .child(div().h(26).px(8).flex().items_center().text_size(12.5).text_color(t.muted).child(title))
      .children(items.map((x) => h_flex().id(id + "-" + x.key).h(30).flex_none().px(8).gap(8).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { pick(x.key); cx.notify(); })
        .child(div().size(16).flex_none().when(x.on, (el) => el.child(svg(HERDR_ICON("check")).size(16).text_color(t.foreground))))
        .child(div().flex_1().min_w(0).truncate().child(x.label))));
  }

  selectAndGo(x, cx) {
    this.selectedKey = x.key;
    go(x);
    cx.notify();
  }

  selectionBorder(selected, keyboard, t) {
    if (!selected) return t.blocked + TINT.clear;
    return keyboard ? t.accent : t.blocked;
  }

  card(x, i, keyboard, t, w) {
    const can = canGo(x), selected = can && x.key === this.selectedKey;
    return v_flex().id("nawaban-card-" + i).flex_none().p(12).rounded(8).bg(t.blocked + TINT.soft)
      .border_1().border_color(this.selectionBorder(selected, keyboard, t))
      .when(can, (el) => el.cursor_pointer().hover((s) => s.bg(t.blocked + TINT.strong))
        .on_click((_e, cx) => this.selectAndGo(x, cx)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(x.name))
        .when(x.duration != null, (el) => el.child(div().flex_none().text_size(12.5).text_color(t.blocked).child(w.waited(x.duration)))))
      .child(clampLines(div().mt(6), CARD_LINE_HEIGHT).child(oneLine(x.question)))
      .child(h_flex().mt(10).gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(x.doing))
        .when(can, (el) => el.child(div().flex_none().px(10).py(5).rounded(6).bg(t.blocked)
          .text_size(12.5).font_semibold().text_color(t.canvas).child(x.focus != null ? w.go : w.issue))));
  }

  group(g, now, keyboard, t, w) {
    return v_flex().flex_none().pt(16).pb(4)
      .child(h_flex().px(16).gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(g.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(w.counts(g.self, g.dispatched))))
      .child(g.decision ? this.decisionLine(g.decision, t, w) : div().h(8))
      .children(this.rail(g.items, now, keyboard, t, w))
      .when(g.closed.length > 0, (el) => el.child(this.closed(g, now, keyboard, t, w)));
  }

  decisionLine(decision, t, w) {
    return h_flex().px(16).mt(3).mb(8).text_size(12).text_color(t.dim)
      .child(div().flex_none().text_color(t.muted).child(decisionDate(decision.at) + " " + w.decided))
      .child(div().flex_1().min_w(0).truncate().child("：" + decision.verdict));
  }

  rail(items, now, keyboard, t, w) {
    return items.map((x, i) => this.item(x, i === 0, i === items.length - 1, now, keyboard, t, w));
  }

  toggleClosed(leader, cx) {
    this.unfolded.has(leader) ? this.unfolded.delete(leader) : this.unfolded.add(leader);
    cx.notify();
  }

  closed(g, now, keyboard, t, w) {
    const open = this.unfolded.has(g.leader);
    return Collapsible.new().flex().flex_col().open(open)
      .child(h_flex().id("nawaban-closed-" + g.leader).h(26).px(16).gap(8).items_center().cursor_pointer()
        .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.toggleClosed(g.leader, cx))
        .child(chevron(open))
        .child(div().flex_1().min_w(0).truncate().child(w.closed(g.closed.length))))
      .content(v_flex().children(this.rail(g.closed, now, keyboard, t, w)));
  }

  itemDot(x, needsYou, t) {
    const ring = (c) => div().size(12).flex_none().rounded_full().border_2().border_color(c).bg(t.canvas);
    if (x.state === "done") return div().size(8).flex_none().rounded_full().bg(t.muted);
    if (x.state === "todo") return div().size(8).flex_none().rounded_full().border_2().border_color(t.dim).bg(t.canvas);
    if (needsYou) return ring(t.blocked);
    if (x.state === "pushing") return ring(t.dim);
    return ring(t.working).flex().items_center().justify_center()
      .child(div().size(4).rounded_full().bg(t.working).loop("opacity", WORKING_PULSE));
  }

  itemRail(x, first, last, held, needsYou, t) {
    const railColor = x.state === "done" ? t.muted : t.border;
    return v_flex().w(GUTTER_W).flex_none().items_center()
      .child(div().w(2).h(held ? 7 : 9).when(!first, (el) => el.bg(railColor)))
      .child(this.itemDot(x, needsYou, t))
      .child(div().w(2).flex_1().min_h(4).when(!last, (el) => el.bg(railColor)));
  }

  itemLine(x, held, w) {
    if (!held) return null;
    const said = x.gone ? (x.note ? w.gone + " · " + x.note : w.gone) : x.note;
    const childIsNamedAlready = x.name != null;
    return [!childIsNamedAlready && x.who && w.who[x.who], said && oneLine(said)].filter(Boolean).join(" · ");
  }

  itemTitleRow(x, there, line, needsYou, now, t, w) {
    const segColor = { done: t.muted, current: t.working, stopped: t.blocked, todo: t.border };
    const stateColor = x.state === "current" ? t.working : needsYou ? t.blocked : t.dim;
    return h_flex().h(26).gap(6).items_center().text_size(12.5)
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(x.number)))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(x.state === "done" || x.state === "todo" ? t.muted : t.foreground).child(x.title))
      .when(Boolean(x.spec), (el) => el
        .when(!this.narrow, (el) => el.child(h_flex().flex_none().gap(3).items_center()
          .children(x.spec.segments.map((s) => div().w(14).h(3).rounded(1).bg(segColor[s])))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(x.spec.done + "/" + x.spec.total)))
      .when(x.name != null && x.name !== x.title, (el) => el.child(div().flex_none().max_w(96).truncate().text_size(11).text_color(t.dim).child(x.name)))
      .child(div().flex_none().text_size(11).text_color(stateColor).child(itemLabel(x, now, this.lang)))
      .when(there && !line, (el) => el.child(div().flex_none().text_size(12).text_color(t.foreground).child(w.go)));
  }

  itemNoteRow(el, line, there, t, w) {
    return el.child(h_flex().gap(10).pb(8).items_end().text_size(12)
      .child(clampLines(div().flex_1().min_w(0), SMALL_LINE_HEIGHT).text_color(t.muted).child(line))
      .when(there, (el) => el.child(div().flex_none().text_color(t.foreground).child(w.go))));
  }

  withWholeNoteOnHover(row, x, t) {
    if (!x.note) return row;
    return HoverCard.new("nawaban-note-" + x.key).anchor("bottom_left").trigger(row)
      .content(div().w(320).p(10).rounded(8).bg(t.popover).border_1().border_color(t.border)
        .text_size(12).line_height(SMALL_LINE_HEIGHT + "px").text_color(t.foreground).child(x.note));
  }

  item(x, first, last, now, keyboard, t, w) {
    const needsYou = x.state === "stopped" || x.state === "waiting";
    const held = x.state === "current" || x.state === "pushing" || needsYou;
    const line = this.itemLine(x, held, w);
    const there = held && x.focus != null;
    const body = v_flex().flex_1().min_w(0)
      .child(this.itemTitleRow(x, there, line, needsYou, now, t, w))
      .when(Boolean(line), (el) => this.itemNoteRow(el, line, there, t, w));
    const row = h_flex().id("nawaban-item-" + x.key).flex_none().px(16).gap(8).items_stretch().min_h(30)
      .when(x.key === this.selectedKey, (el) => el.bg(keyboard ? t.selected : t.hover))
      .when(canGo(x), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.selectAndGo(x, cx)))
      .child(this.itemRail(x, first, last, held, needsYou, t)).child(body);
    return this.withWholeNoteOnHover(row, x, t);
  }
}
