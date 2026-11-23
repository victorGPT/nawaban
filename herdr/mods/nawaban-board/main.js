import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, HoverCard } from "gpui-base";
import { spaces, focused, agents, terminals, run, exec, hc, checking, home, nextCommand, watchFolder, props, closeOverlay } from "herdr";
import { projectFor, repoName, cliFor, resolveLang, moveSelection, keyCommand, boardChanged, okrChanged, folderOf, canGo, panelView,
  sinceLabel, isoMonthDay, WINDOW_WORDS, okrView, OKR_WORDS, OKR_FOLDER_IN_REPO, okrReadingOfFailure, hasNoObjective,
  taskSections, panelKeys, groupOfKey, foldKey, isGroupOpen, moreKey, groupOfMoreKey, decisionCardsView, repoRootOf, TO_ORCHESTRATOR,
  marksStillToKeep, TABS, openingTab, tabBadges } from "./logic.js";

const UNWATCHED_BOARD_REREAD_MS = 5000;
const WATCHED_BOARD_MISSED_CHANGE_REREAD_MS = 60000;
const GITHUB_BOARD_REUSED_FOR_MS = 60000;
const OKR_READ_GIVEN_UP_AFTER_MS = 5000;
const ICON = (name) => "mods/nawaban-board/" + name + ".svg";
const HERDR_ICON = (name) => "mods/workspace-chrome/" + name + ".svg";
const CLI = { board: () => ["node", home() + "/nawaban/board/src/cli.ts"], old: () => ["python3", home() + "/nawaban/nawaban/cli.py"] };
const OLD_CLI_ON_ANOTHER_MACHINE = 'exec python3 "$HOME/nawaban/nawaban/cli.py" "$@"';

const INK = {
  canvas: "#000000", popover: "#0f0f10", border: "#ffffff14", hover: "#ffffff0a", selected: "#ffffff0f",
  title: "#f1f3f7e6", value: "#f1f3f7bf", foreground: "#f1f3f7", muted: "#a3a3a3", dim: "#6b6b6b",
  amber: "#fcd34d", amberText: "#fcd34de6", sky: "#7dd3fc", skyText: "#7dd3fccc",
  red: "#f87171", green: "#34d399", untouched: "#525252", finished: "#3f3f46",
};
const GROUP_LOOK = {
  stopped: { dot: INK.muted, side: INK.dim },
  working: { dot: INK.sky, side: INK.skyText, breathes: true },
  todo: { dot: INK.untouched, side: INK.dim },
  done: { dot: INK.finished, side: INK.dim, faded: true },
};
const GAP_COLOR = { missed: INK.red, stale: INK.amber, met: INK.green, untested: INK.dim };
const OBJECTIVE_TALLY_COLOR = { missed: INK.red, unsure: INK.muted, met: INK.green };
const BADGE_COLOR = { ask: INK.amberText, missed: INK.red, met: INK.green, plain: INK.dim };
const ROW_H = 32;
const GROUP_HEADER_H = 28;
const ROW_PX = 10;
const ROW_GAP = 10;
const ROW_TWO_LINE_PY = 7;
const DOT = 6;
const TITLE_SIZE = 14;
const SIDE_SIZE = 12;
const WHY_SIZE = 12;
const GROUP_SIZE = 11;
const CHEVRON = 12;
const MORE_INDENT = 26;
const SECTION_GAP = 10;
const BODY_PAD = 8;
const CARD_W = 280;
const CARD_LINE_H = 18;
const FACT_LABEL_W = 40;
const HOVER_OPEN_DELAY_MS = 250;
const ICON_BUTTON = 24;
const BREATH = { from: 1, to: 0.35, period: 2000 };
const FOLDS_STORE = "folds";
const SHOWN_ALL_STORE = "groupShownAll";
const RETURNED_STORE = "incompleteCardsReturned";
const TAB_STORE = "tab";
const TAB_H = 34;
const TAB_GAP = 18;
const OBJECTIVE_SIZE = 15;
const KR_NAME_SIZE = 13;
const KR_VALUE_SIZE = 14;
const BUTTON_H = 26;
const DISABLED_OPACITY = 0.3;
const PROGRESS_LINES_SHOWN = 2;

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
const say = (terminal, text) => hc(["send", terminal, text])
  .then((r) => (r.code === 0 ? null : lastLine(r.stderr) || "exit " + r.code), (e) => String(e?.message ?? e));
const openInBrowser = (url) => exec("open", [url]).catch(() => null);
const go = (x) => (x.focus != null ? goTo(x.focus) : x.url ? openInBrowser(x.url) : null);

const readStored = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const store = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};
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
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

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
    this.folds = readStored(FOLDS_STORE, {});
    this.shownAll = readStored(SHOWN_ALL_STORE, {});
    this.pickedTabs = readStored(TAB_STORE, {});
    this.hovered = null;
    this.okr = null;
    this.okrPlace = null;
    this.okrFlight = new Map();
    this.okrGen = 0;
    this.okrTomlWatch = null;
    this.openCard = null;
    this.picked = {};
    this.cardSaid = {};
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
    if (cmd === "left" || cmd === "right") return this.pickTab(moveSelection(TABS, this.tab, cmd === "right" ? 1 : -1));
    if (TABS[cmd - 1]) return this.pickTab(TABS[cmd - 1]);
    if (cmd === "down" || cmd === "up") this.selectedKey = moveSelection(this.keys, this.selectedKey, cmd === "down" ? 1 : -1);
  }

  openSelected() {
    const group = groupOfKey(this.selectedKey);
    if (group) return this.toggleGroup(group);
    const more = groupOfMoreKey(this.selectedKey);
    if (more) return this.toggleShownAll(more);
    const x = this.selectableByKey.get(this.selectedKey);
    if (x?.card) return this.toggleCard(x.key);
    if (x && canGo(x)) go(x);
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
        const git = await this.gitOf(at), via = cliFor(repoName(git), at.on), repo = repoRootOf(git);
        const projects = await nawaban(["json", "projects"], at, undefined, via);
        if (!this.projectOfPlace.has(key)) await this.learnPlace(at, git, projects, via);
        this.db = this.boardFileOfPlace.get(key);
        if (this.db) this.watch(this.db, cx);
        const project = this.projectOfPlace.get(key);
        const board = await this.boardReusingGithubWithinWindow(at, project, via);
        if (placeChangedFrom(key)) return;
        Object.assign(this, { project, projectsList: projects, board, repo, error: null });
        await this.returnIncompleteCards(board, repo);
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

  returnedCards() {
    return readStored(RETURNED_STORE, {})[this.projectKey()] ?? [];
  }

  async returnIncompleteCards(board, repo) {
    if (checking()) return;
    const project = this.projectKey(), returned = this.returnedCards();
    const v = decisionCardsView(board, { terminals: terminals(), repo, returned });
    const due = v.orchestrator ? v.incomplete.unreturned.map((x) => x.mark) : [];
    const keep = (justReturned) => store(RETURNED_STORE, { ...readStored(RETURNED_STORE, {}), [project]: marksStillToKeep(returned, v.incomplete, justReturned) });
    keep(due);
    if (!due.length) return;
    const failed = await say(v.orchestrator, TO_ORCHESTRATOR.incomplete(v.incomplete.unreturned.map((x) => x.id)));
    if (failed) keep([]);
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
    const nothingToShow = !v.waiting.length && !v.tasks.length && !windows.length;
    return nothingToShow ? w.none : null;
  }

  projectKey() {
    return this.project ?? spaces().find((s) => s.active)?.name ?? "";
  }

  toggleGroup(group) {
    const project = this.projectKey();
    this.folds = { ...this.folds, [foldKey(project, group)]: !isGroupOpen(this.folds, project, group) };
    store(FOLDS_STORE, this.folds);
  }

  toggleShownAll(group) {
    const key = foldKey(this.projectKey(), group);
    this.shownAll = { ...this.shownAll, [key]: !this.shownAll[key] };
    store(SHOWN_ALL_STORE, this.shownAll);
  }

  pickTab(tab) {
    if (!this.board) return;
    if (tab !== this.tab) this.selectedKey = null;
    this.tab = tab;
    this.pickedTabs = { ...this.pickedTabs, [this.projectKey()]: tab };
    store(TAB_STORE, this.pickedTabs);
  }

  answerKey(c) {
    return this.projectKey() + ":" + c.mark;
  }

  toggleCard(key) {
    this.openCard = this.openCard === key ? null : key;
  }

  rememberSelectable(tab, decisions, objectives, sections, tasks) {
    const on = (t, keys) => (tab === t ? keys : []);
    this.keys = panelKeys(on("decide", decisions.map((r) => r.key)), on("okr", objectives.flatMap((x) => x.keys)), on("tasks", sections));
    this.selectableByKey = new Map([...decisions, ...objectives.flatMap((x) => [...x.krs, ...x.untested, ...x.met]), ...tasks].map((r) => [r.key, r]));
  }

  objectiveRows(okr, project, o) {
    return (okr?.objectives ?? []).map((ob, i) => {
      const open = isGroupOpen(this.folds, project, ob.fold), foldRow = "group:" + ob.fold;
      const untestedOpen = isGroupOpen(this.folds, project, ob.untestedFold), untestedRow = "group:" + ob.untestedFold;
      const krs = ob.krs.map((k, j) => this.krRow(k, i, j, o));
      const untested = untestedOpen ? ob.untestedKrs.map((k, j) => this.krRow(k, i, ob.krs.length + j, o)) : [];
      const met = open ? ob.metKrs.map((k, j) => this.krRow(k, i, ob.krs.length + ob.untestedKrs.length + j, o)) : [];
      const untestedFolding = ob.untestedKrs.length ? [untestedRow, ...untested.map((r) => r.key)] : [];
      const folding = ob.metKrs.length ? [foldRow, ...met.map((r) => r.key)] : [];
      return { ob, open, foldRow, untestedOpen, untestedRow, krs, untested, met,
        keys: ob.standing === "met" ? folding : [...krs.map((r) => r.key), ...untestedFolding, ...folding] };
    });
  }

  render(cx) {
    const all = agents(), space = spaceId(), mine = all.filter((a) => a.space === space);
    this.rereadOnNewSpaceOrWindowState(mine, cx);
    const w = WINDOW_WORDS[this.lang], o = OKR_WORDS[this.lang];
    const now = Math.floor(Date.now() / 1000);
    const v = panelView({ agents: all, terminals: terminals(), space, board: this.board, now, lang: this.lang,
      projects: this.projectsList, project: this.project });
    const project = this.projectKey();
    const cards = this.board ? decisionCardsView(this.board, { terminals: terminals(), repo: this.repo, returned: this.returnedCards() }) : null;
    this.cardsView = cards;
    const decisions = [...v.waiting.map((x) => this.cardRow(x, w)), ...(cards?.cards ?? []).map((c) => this.decisionRow(c, w))];
    const incomplete = cards?.incomplete.ids.length ? cards.incomplete : null;
    const okr = okrView(this.okr, this.lang);
    const objectives = this.objectiveRows(okr, project, o);
    const sections = taskSections(v.tasks, { folds: this.folds, project, shownAll: this.shownAll })
      .map((s) => ({ ...s, rows: s.items.map((x) => this.taskRow(x, s.group, now, w)) }));
    const tab = this.tab = openingTab(this.pickedTabs[project], decisions.length);
    this.rememberSelectable(tab, decisions, objectives, sections, sections.flatMap((s) => s.rows));
    if (!this.keys.includes(this.selectedKey)) this.selectedKey = null;
    const keyboard = this.keyboard.is_focused();
    const note = this.statusNote(v, mine, w);
    const badges = tabBadges({ pending: decisions.length, okr,
      openTasks: v.tasks.filter((g) => g.group !== "done").reduce((n, g) => n + g.items.length, 0) });

    return v_flex().id("nawaban-board").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(INK.canvas).border_1().border_color(INK.border).text_color(INK.foreground).text_size(TITLE_SIZE)
      .track_focus(this.keyboard).on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(w, mine.length, v.otherWaiting))
      .child(this.tabBar(tab, badges, w))
      .child(v_flex().id("nawaban-body").flex_1().min_h(0).overflow_y_scrollbar().p(BODY_PAD).gap(SECTION_GAP)
        .when(Boolean(note), (el) => el.child(div().flex_none().px(ROW_PX).text_size(WHY_SIZE).text_color(INK.muted).child(note)))
        .when(tab === "decide", (el) => el.child(this.section(null,
          [...decisions.flatMap((r) => this.decisionLines(r, keyboard, cards?.orchestrator, w)),
            ...(incomplete ? [this.incompleteLine(incomplete, cards.orchestrator, w)] : []),
            ...(decisions.length || incomplete || !this.board ? [] : [this.quietLine(w.nothingToDecide)])])))
        .when(tab === "okr" && Boolean(okr), (el) => el.child(this.okrSection(okr, objectives, keyboard, o)))
        .when(tab === "okr" && hasNoObjective(this.okr), (el) => el.child(this.quietLine(o.noObjective)))
        .when(tab === "tasks", (el) => el.children(sections.map((s) => this.taskSection(s, keyboard, w)))));
  }

  onKey(e, cx) {
    const cmd = keyCommand(e);
    if (!cmd) return;
    this.act(cmd);
    cx.stop_propagation();
    cx.notify();
  }

  cardRow(x, w) {
    const question = oneLine(x.question);
    return { key: x.key, dot: INK.amber, title: x.doing || x.name, why: question || null, side: x.duration ?? "", sideColor: INK.amberText,
      focus: x.focus, url: x.url, goLabel: x.focus != null ? w.go : w.issue,
      facts: [[w.facts.window, x.name], [w.facts.question, question], [w.facts.since, x.duration]] };
  }

  taskRow(x, group, now, w) {
    const look = GROUP_LOOK[group], since = sinceLabel(x, now, this.lang);
    return { key: x.key, dot: look.dot, breathes: look.breathes, faded: look.faded, title: x.title, why: x.why ?? null,
      side: since, sideColor: look.side, focus: x.focus, url: x.url, goLabel: x.focus != null ? w.go : w.issue,
      facts: [[w.facts.id, x.id], [w.facts.note, x.note && oneLine(x.note)], [w.facts.spec, x.spec && x.spec.done + "/" + x.spec.total],
        [w.facts.window, x.where], [w.facts.since, since]] };
  }

  decisionRow(c, w) {
    return { key: c.key, card: c, dot: INK.amber, title: c.title, why: c.sub, side: w.cards.chip[c.kind],
      sideColor: c.kind === "maybe" ? INK.amberText : INK.dim, facts: [[w.facts.id, c.id], [w.facts.question, c.decision]] };
  }

  krRow(k, objective, j, o) {
    return { key: "kr:" + objective + "-" + j, objective, kr: k, title: k.name, facts: this.krFacts(k, o) };
  }

  krFacts(k, o) {
    return [[o.value, k.value], [o.target, k.target], [o.asOf, k.as_of && isoMonthDay(k.as_of)], [o.source, k.source], [o.trendLabel, k.trend],
      ...(k.missed_rounds > 0 ? [["", o.rounds(k.missed_rounds)]] : []), ...(k.wait ? [[o.wait, k.wait]] : []),
      ...(k.mismatch ? [["", k.mismatch]] : [])];
  }

  noteHover(key, on, cx) {
    if (on) this.hovered = key;
    else if (this.hovered === key) this.hovered = null;
    cx.notify();
  }

  clickRow(r, cx) {
    this.selectedKey = r.key;
    if (r.card) this.toggleCard(r.key);
    else go(r);
    cx.notify();
  }

  section(header, rows) {
    return v_flex().flex_none().when(Boolean(header), (el) => el.child(header)).child(v_flex().flex_none().gap(1).children(rows));
  }

  sectionHeader(label, count, color) {
    return h_flex().flex_none().h(GROUP_HEADER_H).px(ROW_PX).gap(8).items_center().text_size(GROUP_SIZE).font_medium().text_color(color)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(count), (el) => el.child(div().flex_none().child(count)));
  }

  dot(r) {
    return div().size(DOT).flex_none().rounded_full()
      .when(Boolean(r.hollow), (el) => el.border_1().border_color(r.dot))
      .when(!r.hollow, (el) => el.bg(r.dot))
      .when(Boolean(r.breathes), (el) => el.loop("opacity", BREATH));
  }

  goLabel(r) {
    return h_flex().flex_none().h(22).px(6).gap(4).items_center().rounded(6).text_size(SIDE_SIZE).text_color(INK.muted)
      .hover((s) => s.bg(INK.hover).text_color(INK.foreground))
      .child(r.goLabel)
      .child(svg(ICON("arrow")).size(CHEVRON).flex_none());
  }

  fact([label, value]) {
    return h_flex().gap(8).items_start()
      .child(div().w(FACT_LABEL_W).flex_none().text_color(INK.dim).child(label))
      .child(div().flex_1().min_w(0).child(String(value)));
  }

  knownFacts(r) {
    return r.facts.filter(([, value]) => value != null && value !== "");
  }

  withFactsOnHover(line, r) {
    return HoverCard.new("nawaban-card-" + r.key).anchor("bottom_left").open_delay(HOVER_OPEN_DELAY_MS).trigger(line)
      .content(v_flex().w(CARD_W).px(12).py(10).gap(6).rounded(10).bg(INK.popover).border_1().border_color(INK.border)
        .text_size(WHY_SIZE).line_height(CARD_LINE_H + "px").text_color(INK.value)
        .child(div().text_size(13).font_medium().text_color(INK.foreground).child(r.title))
        .child(div().h(1).bg(INK.border))
        .children(this.knownFacts(r).map((f) => this.fact(f))));
  }

  factsBelow(r) {
    return v_flex().id("nawaban-facts-" + r.key).flex_none().ml(ROW_PX + DOT + ROW_GAP).mr(ROW_PX).mb(6).gap(2)
      .text_size(WHY_SIZE).line_height(CARD_LINE_H + "px").text_color(INK.muted)
      .children(this.knownFacts(r).map((f) => this.fact(f)));
  }

  row(r, keyboard) {
    const selected = r.key === this.selectedKey, reachable = canGo(r) || Boolean(r.card), two = Boolean(r.why);
    const goShown = reachable && (selected || this.hovered === r.key);
    const line = h_flex().id("nawaban-row-" + r.key).flex_none().px(ROW_PX).gap(ROW_GAP).rounded(8)
      .when(two, (el) => el.items_start().py(ROW_TWO_LINE_PY))
      .when(!two, (el) => el.h(ROW_H).items_center())
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(INK.hover)))
      .on_hover((on, cx) => this.noteHover(r.key, on, cx))
      .when(reachable, (el) => el.cursor_pointer().on_click((_e, cx) => this.clickRow(r, cx)))
      .child(this.dot(r).when(two, (el) => el.mt(ROW_TWO_LINE_PY)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(TITLE_SIZE).text_color(r.faded ? INK.dim : INK.title).child(r.title))
        .when(two, (el) => el.child(div().truncate().text_size(WHY_SIZE).text_color(INK.muted).child(r.why))))
      .when(goShown, (el) => el.child(this.goLabel(r)))
      .when(!goShown && Boolean(r.side), (el) => el.child(div().flex_none().text_size(SIDE_SIZE).text_color(r.sideColor).child(r.side)));
    return [this.withFactsOnHover(line, r), ...(keyboard && selected ? [this.factsBelow(r)] : [])];
  }

  decisionLines(r, keyboard, orchestrator, w) {
    const open = Boolean(r.card) && this.openCard === r.key;
    return [...this.row(r, keyboard), ...(open ? [this.cardDetail(r.card, orchestrator, w.cards)] : [])];
  }

  handToOrchestrator(c, orchestrator, text, done, cw, cx) {
    this.cardSaid = { ...this.cardSaid, [this.answerKey(c)]: { text: cw.sending, final: true } };
    cx.spawn(async (cx) => {
      const failed = await say(orchestrator, text);
      this.cardSaid = { ...this.cardSaid, [this.answerKey(c)]: { text: failed ? cw.failed(failed) : done, final: !failed } };
      cx.notify();
    });
  }

  cardDetail(c, orchestrator, cw) {
    const said = this.cardSaid[this.answerKey(c)];
    const body = v_flex().id("nawaban-card-" + c.key).flex_none().ml(ROW_PX + DOT + ROW_GAP).mr(ROW_PX).mb(10).gap(10)
      .text_size(WHY_SIZE).line_height(CARD_LINE_H + "px").text_color(INK.muted);
    if (said?.final) return body.child(div().whitespace_normal().child(said.text));
    const needsOrchestrator = c.kind !== "talk";
    const part = (text, color) => div().text_size(KR_NAME_SIZE).text_color(color).whitespace_normal().child(text);
    return body
      .child(this.labelled(cw.decision, part(c.decision, INK.foreground)))
      .child(this.labelled(cw.kr, part(c.kr, INK.value)))
      .child(this.labelled(cw.context, part(c.context, INK.value)))
      .child(this.labelled(cw.progress,
        div().max_h(PROGRESS_LINES_SHOWN * CARD_LINE_H).overflow_hidden().whitespace_normal().child(c.progress ?? cw.noProgress)))
      .child(v_flex().gap(6).children(c.options.map((opt) => this.optionButton(c, opt, c.kind === "pick"))))
      .child(h_flex().gap(6).items_start().child(div().flex_none().text_color(INK.dim).child(cw.rec))
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(INK.foreground).child(c.rec)))
      .when(needsOrchestrator && !orchestrator, (el) => el.child(div().text_color(INK.amberText).child(cw.noOrchestrator)))
      .when(Boolean(said), (el) => el.child(div().text_color(INK.red).child(said.text)))
      .child(h_flex().gap(8).items_center().flex_wrap().children(this.cardActions(c, orchestrator, cw))
        .when(Boolean(c.url), (el) => el.child(div().id("nawaban-full-" + c.key).flex_1().min_w(0).text_color(INK.dim).cursor_pointer()
          .hover((s) => s.text_color(INK.muted)).on_click(() => openInBrowser(c.url)).child(cw.fullText + " →"))));
  }

  cardActions(c, orchestrator, cw) {
    const hand = (text, done) => (cx) => this.handToOrchestrator(c, orchestrator, text, done, cw, cx);
    const off = !orchestrator, id = (what) => "nawaban-" + what + "-" + c.key;
    if (c.kind === "pick") {
      const option = this.picked[this.answerKey(c)];
      return [this.button(id("settle"), cw.settle, true, off || !option, hand(TO_ORCHESTRATOR.pick(c.id, option), cw.picked(c.id, option))),
        this.button(id("unclear"), cw.unclear, false, off, hand(TO_ORCHESTRATOR.unclear(c.id), cw.sentBack))];
    }
    if (c.kind === "maybe") {
      return [this.button(id("decided"), cw.decided, true, off, hand(TO_ORCHESTRATOR.decided(c.id), cw.closing(c.id))),
        this.button(id("not-yet"), cw.notYet, false, false, () => { this.openCard = null; })];
    }
    return [this.button(id("talk"), cw.goTalk(c.window.name), true, c.window.focus == null, () => goTo(c.window.focus))];
  }

  labelled(label, content) {
    return v_flex().gap(2).child(div().text_size(GROUP_SIZE).text_color(INK.dim).child(label)).child(content);
  }

  button(id, label, primary, disabled, act) {
    return h_flex().id(id).flex_none().h(BUTTON_H).px(12).items_center().rounded(6).text_size(KR_NAME_SIZE)
      .when(primary, (el) => el.bg(INK.foreground).text_color(INK.canvas))
      .when(!primary, (el) => el.border_1().border_color(INK.border).text_color(INK.muted))
      .when(disabled, (el) => el.opacity(DISABLED_OPACITY))
      .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => { act(cx); cx.notify(); }))
      .child(label);
  }

  optionButton(c, opt, pickable) {
    const on = pickable && this.picked[this.answerKey(c)] === opt.key;
    return v_flex().id("nawaban-option-" + c.key + "-" + opt.key).flex_none().px(10).py(7).gap(1).rounded(6).border_1()
      .border_color(on ? INK.sky : INK.border)
      .when(on, (el) => el.bg(INK.selected))
      .when(pickable && !on, (el) => el.cursor_pointer().hover((s) => s.bg(INK.hover)))
      .when(pickable, (el) => el.on_click((_e, cx) => { this.picked = { ...this.picked, [this.answerKey(c)]: opt.key }; cx.notify(); }))
      .child(div().text_size(KR_NAME_SIZE).text_color(INK.title).whitespace_normal().child(opt.key + " · " + opt.text))
      .when(Boolean(opt.note), (el) => el.child(div().text_size(GROUP_SIZE).text_color(INK.dim).child(opt.note)));
  }

  incompleteLine(incomplete, orchestrator, w) {
    const state = !incomplete.unreturned.length ? "returned" : orchestrator ? "returning" : "stuck";
    return div().flex_none().px(ROW_PX).py(6).text_size(SIDE_SIZE).text_color(INK.dim).whitespace_normal()
      .child(w.cards.incomplete(incomplete.ids, state));
  }

  okrSection(okr, objectives, keyboard, o) {
    return this.section(this.sectionHeader(o.tally(okr.met, okr.total, okr.measured), "", INK.dim),
      objectives.flatMap((x) => (x.ob.standing === "met" ? [this.quietObjective(x, o), ...x.met.flatMap((r) => this.krLine(r, keyboard, o, true))]
        : [this.objectiveHeading(x.ob, o), ...x.krs.flatMap((r) => this.krLine(r, keyboard, o, false)),
          ...(x.ob.untestedKrs.length ? [this.fold(x.untestedRow, x.untestedOpen, o.untestedFolded(x.ob.untestedKrs.length)),
            ...x.untested.flatMap((r) => this.krLine(r, keyboard, o, true))] : []),
          ...(x.ob.metKrs.length ? [this.fold(x.foldRow, x.open, o.metFolded(x.ob.metKrs.length)), ...x.met.flatMap((r) => this.krLine(r, keyboard, o, true))] : [])])));
  }

  tabBar(tab, badges, w) {
    return h_flex().flex_none().h(TAB_H).px(14).gap(TAB_GAP).items_end().border_b_1().border_color(INK.border)
      .children(TABS.map((t) => this.tabLabel(t, t === tab, badges[t], w)));
  }

  tabLabel(t, on, badge, w) {
    return h_flex().id("nawaban-tab-" + t).flex_none().h_full().gap(6).items_center().cursor_pointer().text_size(13)
      .text_color(on ? INK.foreground : INK.dim)
      .when(on, (el) => el.border_b_1().border_color(INK.foreground))
      .when(!on, (el) => el.hover((s) => s.text_color(INK.muted)))
      .on_click((_e, cx) => { this.pickTab(t); cx.notify(); })
      .child(w.tabs[t])
      .when(Boolean(badge), (el) => el.child(div().flex_none().text_size(SIDE_SIZE).text_color(BADGE_COLOR[badge.tone]).child(badge.text)));
  }

  quietLine(text) {
    return div().flex_none().h(ROW_H).px(ROW_PX).flex().items_center().text_size(13).text_color(INK.dim).child(text);
  }

  objectiveHeading(ob, o) {
    return h_flex().flex_none().px(ROW_PX).pt(12).pb(4).gap(12).items_end()
      .child(div().flex_1().min_w(0).truncate().text_size(OBJECTIVE_SIZE).font_semibold().text_color(INK.foreground).child(ob.name))
      .child(div().flex_none().text_size(SIDE_SIZE).text_color(OBJECTIVE_TALLY_COLOR[ob.standing]).child(ob.met + "/" + ob.total));
  }

  quietObjective(x, o) {
    return this.foldRow(x.foldRow, h_flex().flex_none().h(ROW_H).px(ROW_PX).gap(12).items_center()
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(INK.muted).child(x.ob.name))
      .child(div().flex_none().text_size(SIDE_SIZE).text_color(OBJECTIVE_TALLY_COLOR.met).child(o.allMet + " " + x.ob.met + "/" + x.ob.total)));
  }

  fold(key, open, label) {
    return this.foldRow(key, h_flex().flex_none().h(GROUP_HEADER_H).pl(MORE_INDENT).items_center().text_size(SIDE_SIZE)
      .text_color(INK.dim).hover((s) => s.text_color(INK.muted)).child((open ? "▾ " : "▸ ") + label));
  }

  foldRow(key, line) {
    const selected = key === this.selectedKey;
    return line.id("nawaban-" + key).rounded(8).cursor_pointer()
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(INK.hover)))
      .on_click((_e, cx) => this.clickGroup({ key, group: groupOfKey(key) }, cx));
  }

  krLine(r, keyboard, o, quiet) {
    const k = r.kr, selected = r.key === this.selectedKey;
    const line = v_flex().id("nawaban-row-" + r.key).flex_none().pl(MORE_INDENT).pr(ROW_PX).pt(4).pb(6).gap(1).rounded(8)
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(INK.hover)))
      .on_hover((on, cx) => this.noteHover(r.key, on, cx))
      .child(div().truncate().text_size(KR_NAME_SIZE).text_color(quiet || !k.measured ? INK.muted : INK.value).child(k.name))
      .child(this.krReading(k, o, quiet));
    return [this.withFactsOnHover(line, r), ...(keyboard && selected ? [this.factsBelow(r)] : [])];
  }

  krReading(k, o, quiet) {
    const dim = (text) => div().flex_none().text_color(INK.dim).child(text);
    if (!k.measured) return h_flex().text_size(SIDE_SIZE).child(dim(o.status.untested + " · " + o.target + " " + k.target));
    return h_flex().flex_wrap().items_baseline().gap(4).text_size(SIDE_SIZE)
      .child(div().flex_none().text_size(quiet ? KR_NAME_SIZE : KR_VALUE_SIZE).when(!quiet, (el) => el.font_semibold())
        .text_color(k.status === "missed" ? INK.red : INK.value).child(k.value))
      .child(dim("/ " + o.target + " " + k.target))
      .when(Boolean(k.gap), (el) => el.child(dim("·")).child(div().flex_none().text_color(GAP_COLOR[k.status]).child(k.gap)))
      .when(Boolean(k.day), (el) => el.child(dim("· " + k.day)));
  }

  clickGroup(s, cx) {
    this.selectedKey = s.key;
    this.toggleGroup(s.group);
    cx.notify();
  }

  clickMore(s, cx) {
    this.selectedKey = moreKey(s.group);
    this.toggleShownAll(s.group);
    cx.notify();
  }

  groupHeader(s, w) {
    const selected = s.key === this.selectedKey, pointed = selected || this.hovered === s.key;
    return h_flex().id("nawaban-" + s.key).flex_none().h(GROUP_HEADER_H).px(ROW_PX).gap(8).items_center().rounded(8).cursor_pointer()
      .text_size(GROUP_SIZE).font_medium().text_color(pointed ? INK.muted : INK.dim)
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((st) => st.bg(INK.hover)))
      .on_hover((on, cx) => this.noteHover(s.key, on, cx))
      .on_click((_e, cx) => this.clickGroup(s, cx))
      .child(div().size(CHEVRON).flex_none()
        .when(pointed, (el) => el.child(svg(HERDR_ICON(s.open ? "chevron-down" : "chevron-right")).size(CHEVRON))))
      .child(div().flex_1().min_w(0).truncate().child(w.groups[s.group]))
      .child(div().flex_none().child(String(s.count)));
  }

  moreRow(s, w) {
    const selected = this.selectedKey === moreKey(s.group);
    return h_flex().id("nawaban-more-" + s.group).flex_none().h(GROUP_HEADER_H).pl(MORE_INDENT).items_center().rounded(8).cursor_pointer()
      .text_size(SIDE_SIZE).text_color(INK.dim)
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((st) => st.bg(INK.hover).text_color(INK.muted)))
      .on_click((_e, cx) => this.clickMore(s, cx))
      .child(s.more.hidden ? w.more(s.more.hidden) : w.less);
  }

  taskSection(s, keyboard, w) {
    const rows = s.open ? [...s.rows.flatMap((r) => this.row(r, keyboard)), ...(s.more ? [this.moreRow(s, w)] : [])] : [];
    return this.section(this.groupHeader(s, w), rows);
  }

  pickLang(lang) {
    saveLang(lang);
    this.moreOpen = false;
    this.lang = lang;
  }

  languageMenu(w) {
    return Popover.new("nawaban-more-menu").anchor("top_right").open(Boolean(this.moreOpen))
      .on_open_change((open, cx) => { this.moreOpen = open; cx.notify(); })
      .trigger(h_flex().id("nawaban-more").size(ICON_BUTTON).flex_none().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(INK.dim).hover((s) => s.bg(INK.hover).text_color(INK.foreground))
        .child(svg(ICON("more")).size(16).flex_none()))
      .content(this.menu("nawaban-lang", [
        { key: "zh", label: "中文", on: this.lang === "zh" },
        { key: "en", label: "English", on: this.lang === "en" },
      ], (lang) => this.pickLang(lang), w.language));
  }

  closeButton(el) {
    return el.child(h_flex().id("nawaban-close").size(ICON_BUTTON).flex_none().items_center()
      .justify_center().rounded(6).cursor_pointer().text_color(INK.dim).hover((s) => s.bg(INK.hover).text_color(INK.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => closeOverlay(props().overlay))
      .child("✕"));
  }

  header(w, windows, elsewhere) {
    const openedAsOverlay = Boolean(props()?.overlay);
    return h_flex().h(48).flex_none().pl(14).pr(8).gap(10).items_center().border_b_1().border_color(INK.border)
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(INK.title).child(this.projectKey()))
      .child(div().flex_none().text_size(GROUP_SIZE).text_color(INK.dim).child(w.windows(windows) + " · " + w.elsewhere(elsewhere)))
      .child(this.languageMenu(w))
      .when(openedAsOverlay, (el) => this.closeButton(el));
  }

  menu(id, items, pick, title) {
    return v_flex().id(id).w(220).mt(4).p(4).gap(1).rounded(8)
      .bg(INK.popover).border_1().border_color(INK.border).text_size(13.5)
      .child(div().h(26).px(8).flex().items_center().text_size(12.5).text_color(INK.muted).child(title))
      .children(items.map((x) => h_flex().id(id + "-" + x.key).h(30).flex_none().px(8).gap(8).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(INK.hover))
        .on_click((_e, cx) => { pick(x.key); cx.notify(); })
        .child(div().size(16).flex_none().when(x.on, (el) => el.child(svg(HERDR_ICON("check")).size(16).text_color(INK.foreground))))
        .child(div().flex_1().min_w(0).truncate().child(x.label))));
  }
}
