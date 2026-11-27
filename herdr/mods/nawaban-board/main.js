import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, HoverCard, InputState, Input } from "gpui-base";
import { spaces, focused, agents, terminals, run, exec, hc, checking, home, nextCommand, watchFolder, props, closeOverlay } from "herdr";
import { projectFor, resolveLang, moveSelection, keyCommand, boardChanged, okrChanged, folderOf, canGo, panelView,
  sinceLabel, isoMonthDay, WINDOW_WORDS, okrView, OKR_WORDS, OKR_FOLDER_IN_REPO, okrReadingOfFailure, hasNoObjective,
  taskSections, panelKeys, groupOfKey, foldKey, isGroupOpen, moreKey, groupOfMoreKey, decisionCardsView, repoRootOf, TO_ORCHESTRATOR,
  marksStillToKeep, TABS, openingTab, tabBadges, orchestratorOf, CAPTURE_FOLD, captureStoreKey, capturesFrom, addCapture, removeCapture,
  markHanded, captureView, unhandedCount, localMonthDayTime } from "./logic.js";

const UNWATCHED_BOARD_REREAD_MS = 5000;
const WATCHED_BOARD_MISSED_CHANGE_REREAD_MS = 60000;
const OKR_READ_GIVEN_UP_AFTER_MS = 5000;
const ICON = (name) => "mods/nawaban-board/" + name + ".svg";
const HERDR_ICON = (name) => "mods/workspace-chrome/" + name + ".svg";
const CLI = () => home() + "/.local/bin/nawaban";
const CLI_ON_ANOTHER_MACHINE = 'exec "$HOME/.local/bin/nawaban" "$@"';

const INK = {
  canvas: "#000000", popover: "#0f0f10", border: "#ffffff14", hover: "#ffffff0a", selected: "#ffffff0f",
  card: "#ffffff08", cardEdge: "#ffffff12", cardHover: "#ffffff0d", cardSelected: "#ffffff14", cardSelectedEdge: "#ffffff29",
  control: "#ffffff1f", segment: "#ffffff17", track: "#ffffff12",
  title: "#f1f3f7e6", value: "#f1f3f7bf", foreground: "#f1f3f7", muted: "#a3a3a3", meta: "#8a8a8a", dim: "#6b6b6b",
  amber: "#fcd34d", amberText: "#fcd34de6", sky: "#7dd3fc", skyText: "#7dd3fccc",
  red: "#f87171", green: "#34d399", untouched: "#525252", finished: "#3f3f46",
};
const TINT = "1f";
const GROUP_LOOK = {
  stopped: { accent: INK.dim, side: INK.dim },
  working: { accent: INK.green, side: INK.green, breathes: true },
  todo: { accent: INK.untouched, side: INK.dim },
  done: { accent: INK.finished, side: INK.dim, faded: true },
};
const GAP_COLOR = { missed: INK.red, unmeasurable: INK.amber, undecided: INK.amber, stale: INK.amber, met: INK.green, untested: INK.dim };
const OBJECTIVE_TALLY_COLOR = { missed: INK.red, unsure: INK.muted, met: INK.green };
const BADGE_COLOR = { ask: INK.amberText, missed: INK.red, met: INK.green, plain: INK.dim };
const CHIP_COLOR = { pick: INK.amber, maybe: INK.amber, talk: INK.sky, waiting: INK.amber };
const TYPE = { tag: 11, meta: 12, label: 13, body: 14, heading: 15 };
const SPACE = { xs: 2, s: 4, m: 8, l: 12, xl: 16 };
const RADIUS = { bar: 1, tag: 4, segment: 6, control: 8, card: 10 };
const HEADER_H = 48;
const SEGMENT_H = 26;
const ROW_H = 32;
const GROUP_HEADER_H = 28;
const BUTTON_H = 28;
const TAG_H = 18;
const COUNT_H = 16;
const ACCENT_H = 2;
const BAR_H = 4;
const ICON_BUTTON = 24;
const ICON_SIZE = 16;
const CHEVRON = 12;
const CARD_PAD = 12;
const CARD_LINE_H = 18;
const FACT_LABEL_W = 40;
const HOVER_CARD_W = 280;
const MENU_W = 220;
const MENU_ITEM_H = 30;
const MENU_TITLE_H = 26;
const HOVER_OPEN_DELAY_MS = 250;
const BREATH = { from: 1, to: 0.35, period: 2000 };
const FOLDS_STORE = "folds";
const SHOWN_ALL_STORE = "groupShownAll";
const RETURNED_STORE = "incompleteCardsReturned";
const TAB_STORE = "tab";
const DISABLED_OPACITY = 0.3;
const PROGRESS_LINES_SHOWN = 2;
const STRUCTURED_TARGET = /^([≥≤<>=])\s*(-?\d+(?:\.\d+)?)/;
const LOWER_IS_BETTER = new Set(["≤", "<"]);

function place() {
  const space = spaces().find((s) => s.active);
  const on = space?.machine ?? null;
  const cwd = focused()?.cwd || space?.folder || (on ? undefined : home());
  return { on, cwd, key: (on ?? "") + "|" + (cwd ?? "~") };
}
const placeChangedFrom = (key) => place().key !== key;

const spaceId = () => focused()?.space ?? spaces().find((s) => s.active)?.id;

const runCli = (args, at, timeout) =>
  at.on
    ? exec("sh", ["-c", CLI_ON_ANOTHER_MACHINE, "sh", ...args], { cwd: at.cwd, on: at.on, timeout })
    : exec("sh", [CLI(), ...args], { cwd: at.cwd, timeout });

const parseJsonOrNull = (text) => {
  try { return JSON.parse(text || "null"); } catch { return null; }
};
const lastLine = (text) => text?.trim().split("\n").pop();
const crashLine = (text) => text?.split("\n").find((l) => /^\w*Error\b/.test(l)) ?? lastLine(text);

async function nawaban(args, at, timeout) {
  const r = await runCli(args, at, timeout);
  const out = parseJsonOrNull(r.stdout);
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || crashLine(r.stderr) || "exit " + r.code);
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

export const krFill = (k) => {
  const goal = STRUCTURED_TARGET.exec(String(k.target ?? "")), value = parseFloat(k.value);
  if (!k.measured || !goal || !Number.isFinite(value)) return null;
  const target = Number(goal[2]);
  const fill = LOWER_IS_BETTER.has(goal[1]) ? (value <= target ? 1 : target / value) : target > 0 ? value / target : value >= target ? 1 : 0;
  return Math.min(1, Math.max(0, fill));
};

const capturesInFlight = new Set();
const inFlightKey = (project, id) => captureStoreKey(project) + ":" + id;

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
    this.listenToCaptureInput();
    this.keyboard = cx.focus_handle();
    this.refresh(cx);
    this.obeyCommands(cx);
    cx.timer.every(UNWATCHED_BOARD_REREAD_MS, (cx) => {
      if (this.watchKeepsBoardFresh()) return;
      this.refresh(cx);
    });
  }

  listenToCaptureInput() {
    this.captureFailed = {};
    this.captureInput = InputState.new({ placeholder: WINDOW_WORDS[this.lang].capture.placeholder });
    this.captureInput.on("submit", (_e, cx) => { this.keepCapture(); cx.notify(); });
    this.captureInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.captureInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  captures(project) {
    return capturesFrom(readStored(captureStoreKey(project), []));
  }

  changeCaptures(project, change) {
    store(captureStoreKey(project), change(this.captures(project)));
  }

  keepCapture() {
    const text = this.captureInput.value();
    if (!text.trim()) return;
    this.changeCaptures(this.projectKey(), (list) => addCapture(list, text, Date.now()));
    this.captureInput.set_value("");
  }

  handCapture(item, orchestrator, cx) {
    const project = this.projectKey(), id = item.id, flight = inFlightKey(project, id);
    const stillUnhanded = this.captures(project).some((x) => x.id === id && !Number.isFinite(x.handedAt));
    if (capturesInFlight.has(flight) || !stillUnhanded) return;
    capturesInFlight.add(flight);
    this.captureFailed = { ...this.captureFailed, [id]: null };
    cx.spawn(async (cx) => {
      const failed = await say(orchestrator, TO_ORCHESTRATOR.capture(item.text));
      if (!failed) this.changeCaptures(project, (list) => markHanded(list, id, Date.now()));
      capturesInFlight.delete(flight);
      this.captureFailed = { ...this.captureFailed, [id]: failed };
      cx.notify();
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
        const git = await this.gitOf(at), repo = repoRootOf(git);
        const projects = await nawaban(["json", "projects"], at);
        if (!this.projectOfPlace.has(key)) await this.learnPlace(at, git, projects);
        this.db = this.boardFileOfPlace.get(key);
        if (this.db) this.watch(this.db, cx);
        const project = this.projectOfPlace.get(key);
        const board = await nawaban(["json", "board", ...(project ? ["--project", project] : [])], at);
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

  async learnPlace(at, git, projects) {
    this.boardFileOfPlace.set(at.key, at.on ? null : await nawaban(["json", "db"], at).then((out) => out.db, () => null));
    this.projectOfPlace.set(at.key, projectFor(git, projects));
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
      const okr = await nawaban(["json", "okr"], at, OKR_READ_GIVEN_UP_AFTER_MS).catch(okrReadingOfFailure);
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
    if (this.board.syncNote) return this.board.syncNote;
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

  rememberSelectable(tab, decisions, objectives, sections, tasks, captureKeys) {
    const on = (t, keys) => (tab === t ? keys : []);
    this.keys = [...panelKeys(on("decide", decisions.map((r) => r.key)), on("okr", objectives.flatMap((x) => x.keys)), on("tasks", sections)),
      ...on("capture", captureKeys)];
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
    const captured = this.captures(project), captures = captureView(captured);
    const handedRow = "group:" + CAPTURE_FOLD;
    const tab = this.tab = openingTab(this.pickedTabs[project], decisions.length);
    this.rememberSelectable(tab, decisions, objectives, sections, sections.flatMap((s) => s.rows), captures.handed.length ? [handedRow] : []);
    if (!this.keys.includes(this.selectedKey)) this.selectedKey = null;
    const keyboard = this.keyboard.is_focused();
    const note = this.statusNote(v, mine, w);
    const badges = tabBadges({ pending: decisions.length, okr,
      openTasks: v.tasks.filter((g) => g.group !== "done").reduce((n, g) => n + g.items.length, 0), unhanded: unhandedCount(captured) });

    return v_flex().id("nawaban-board").size_full().min_h(0).rounded(RADIUS.card).overflow_hidden()
      .bg(INK.canvas).border_1().border_color(INK.border).text_color(INK.foreground).text_size(TYPE.body)
      .track_focus(this.keyboard).on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(w, mine.length, v.otherWaiting))
      .child(this.tabBar(tab, badges, w))
      .child(v_flex().id("nawaban-body").flex_1().min_h(0).overflow_y_scrollbar().p(SPACE.l).gap(SPACE.xl)
        .when(Boolean(note), (el) => el.child(div().flex_none().px(SPACE.s).text_size(TYPE.meta).text_color(INK.muted).child(note)))
        .when(tab === "decide", (el) => el.child(this.section(null,
          [...decisions.flatMap((r) => this.decisionLines(r, keyboard, cards?.orchestrator, w)),
            ...(incomplete ? [this.incompleteLine(incomplete, cards.orchestrator, w)] : []),
            ...(decisions.length || incomplete || !this.board ? [] : [this.quietLine(w.nothingToDecide)])])))
        .when(tab === "okr" && Boolean(okr), (el) => el.child(this.okrSection(okr, objectives, keyboard, o)))
        .when(tab === "okr" && hasNoObjective(this.okr), (el) => el.child(this.quietLine(o.noObjective)))
        .when(tab === "tasks" && Boolean(v.flow), (el) => el.child(div().flex_none().px(SPACE.s).text_size(TYPE.meta).text_color(INK.muted).child(v.flow)))
        .when(tab === "tasks", (el) => el.children(sections.map((s) => this.taskSection(s, keyboard, w))))
        .when(tab === "capture", (el) => el.child(this.captureSection(captures, handedRow, orchestratorOf(terminals(), this.repo)?.address ?? null, w))));
  }

  captureSection(captures, handedRow, orchestrator, w) {
    const handedOpen = isGroupOpen(this.folds, this.projectKey(), CAPTURE_FOLD);
    const nothing = !captures.open.length && !captures.handed.length;
    return this.section(null, [
      Input.new(this.captureInput).flex_none().h(ROW_H).px(SPACE.m).rounded(RADIUS.control).border_1()
        .border_color(this.typing ? INK.cardSelectedEdge : INK.control).bg(INK.card).text_size(TYPE.body).text_color(INK.foreground),
      ...(nothing ? [this.quietLine(w.capture.empty)] : []),
      ...captures.open.map((x) => this.captureCard(x, orchestrator, w, false)),
      ...(captures.handed.length ? [this.fold(handedRow, handedOpen, w.capture.handedGroup(captures.handed.length))] : []),
      ...(handedOpen ? captures.handed.map((x) => this.captureCard(x, orchestrator, w, true)) : [])]);
  }

  captureCard(x, orchestrator, w, handed) {
    const cw = w.capture, sending = capturesInFlight.has(inFlightKey(this.projectKey(), x.id)), failed = this.captureFailed[x.id];
    const id = (what) => "nawaban-capture-" + what + "-" + x.id;
    return this.card().id(id("card")).p(CARD_PAD).gap(SPACE.s)
      .child(div().text_size(TYPE.body).text_color(handed ? INK.dim : INK.title).whitespace_normal().child(x.text))
      .child(div().text_size(TYPE.meta).text_color(INK.dim).child(handed ? cw.handed(localMonthDayTime(x.handedAt)) : localMonthDayTime(x.at)))
      .when(!handed && !orchestrator, (el) => el.child(div().text_size(TYPE.meta).text_color(INK.amberText).child(cw.noOrchestrator)))
      .when(!handed && Boolean(failed), (el) => el.child(div().text_size(TYPE.meta).text_color(INK.red).whitespace_normal().child(w.cards.failed(failed))))
      .child(h_flex().pt(SPACE.xs).gap(SPACE.m).items_center()
        .when(!handed, (el) => el.child(this.button(id("hand"), sending ? w.cards.sending : cw.hand, true, !orchestrator || sending,
          (cx) => this.handCapture(x, orchestrator, cx))))
        .child(this.button(id("remove"), cw.remove, false, sending, () => this.changeCaptures(this.projectKey(), (list) => removeCapture(list, x.id)))));
  }

  onKey(e, cx) {
    if (this.typing) return;
    const cmd = keyCommand(e);
    if (!cmd) return;
    this.act(cmd);
    cx.stop_propagation();
    cx.notify();
  }

  cardRow(x, w) {
    const question = oneLine(x.question), who = x.doing || x.name;
    return { key: x.key, meta: [who, x.duration].filter(Boolean).join(" · "), title: question || who, tag: w.waiting, tagColor: CHIP_COLOR.waiting,
      focus: x.focus, url: x.url, goLabel: x.focus != null ? w.go : w.issue,
      facts: [[w.facts.window, x.name], [w.facts.question, question], [w.facts.since, x.duration]] };
  }

  taskRow(x, group, now, w) {
    const look = GROUP_LOOK[group], since = sinceLabel(x, now, this.lang);
    return { key: x.key, accent: look.accent, breathes: look.breathes, faded: look.faded || Boolean(x.doing?.stale), title: x.doing?.head ?? x.title,
      why: x.doing?.chain ?? x.why ?? null,
      side: since, sideColor: look.side, focus: x.focus, url: x.url, goLabel: x.focus != null ? w.go : w.issue,
      facts: [[w.facts.id, x.id], [w.facts.note, x.note && oneLine(x.note)], [w.facts.spec, x.spec && x.spec.done + "/" + x.spec.total],
        [w.facts.window, x.where], [w.facts.since, since]] };
  }

  decisionRow(c, w) {
    return { key: c.key, card: c, meta: c.sub, title: c.title, tag: w.cards.chip[c.kind], tagColor: CHIP_COLOR[c.kind],
      facts: [[w.facts.id, c.id], [w.cards.decision, c.decision]] };
  }

  krRow(k, objective, j, o) {
    return { key: "kr:" + objective + "-" + j, objective, kr: k, title: k.name, facts: this.krFacts(k, o) };
  }

  krFacts(k, o) {
    return [[o.value, k.value], [o.target, k.target], [o.asOf, k.as_of && isoMonthDay(k.as_of)], [o.source, k.source], [o.trendLabel, k.trend],
      ...(k.missed_rounds > 0 ? [["", o.rounds(k.missed_rounds)]] : []), ...(k.wait ? [[o.wait, k.wait]] : []),
      ...(k.mismatch ? [["", k.mismatch]] : []), ...(k.failure ? [[o.failure, k.failure]] : []), ...(k.series ? [["", k.series]] : [])];
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
    return v_flex().flex_none().gap(SPACE.m).when(Boolean(header), (el) => el.child(header)).children(rows);
  }

  sectionHeader(label, count, color) {
    return h_flex().flex_none().px(SPACE.s).gap(SPACE.m).items_center().text_size(TYPE.label).font_semibold().text_color(color)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(count), (el) => el.child(div().flex_none().child(count)));
  }

  tag(text, color, height = TAG_H) {
    return h_flex().flex_none().h(height).px(SPACE.s + SPACE.xs).items_center().rounded(RADIUS.tag)
      .text_size(TYPE.tag).font_medium().text_color(color).bg(color + TINT).child(text);
  }

  card() {
    return v_flex().flex_none().rounded(RADIUS.card).border_1().border_color(INK.cardEdge).bg(INK.card);
  }

  accent(r) {
    return div().flex_none().h(ACCENT_H).mx(RADIUS.card).bg(r.accent)
      .when(Boolean(r.breathes), (el) => el.loop("opacity", BREATH));
  }

  goLabel(r) {
    return h_flex().flex_none().h(TAG_H).px(SPACE.s).gap(SPACE.s).items_center().rounded(RADIUS.tag).text_size(TYPE.meta).text_color(INK.muted)
      .hover((s) => s.bg(INK.hover).text_color(INK.foreground))
      .child(r.goLabel)
      .child(svg(ICON("arrow")).size(CHEVRON).flex_none());
  }

  fact([label, value]) {
    return h_flex().gap(SPACE.m).items_start()
      .child(div().w(FACT_LABEL_W).flex_none().text_color(INK.dim).child(label))
      .child(div().flex_1().min_w(0).child(String(value)));
  }

  knownFacts(r) {
    return r.facts.filter(([, value]) => value != null && value !== "");
  }

  withFactsOnHover(line, r) {
    return HoverCard.new("nawaban-card-" + r.key).anchor("bottom_left").open_delay(HOVER_OPEN_DELAY_MS).trigger(line)
      .content(v_flex().w(HOVER_CARD_W).p(SPACE.l).gap(SPACE.s).rounded(RADIUS.card).bg(INK.popover).border_1().border_color(INK.border)
        .text_size(TYPE.meta).line_height(CARD_LINE_H + "px").text_color(INK.value)
        .child(div().text_size(TYPE.label).font_semibold().text_color(INK.foreground).child(r.title))
        .child(div().h(1).bg(INK.border))
        .children(this.knownFacts(r).map((f) => this.fact(f))));
  }

  factsBelow(r) {
    return v_flex().id("nawaban-facts-" + r.key).flex_none().px(CARD_PAD).pb(CARD_PAD).gap(SPACE.xs)
      .text_size(TYPE.meta).line_height(CARD_LINE_H + "px").text_color(INK.muted)
      .children(this.knownFacts(r).map((f) => this.fact(f)));
  }

  row(r, keyboard, below = []) {
    const selected = r.key === this.selectedKey, reachable = canGo(r) || Boolean(r.card);
    const goShown = reachable && (selected || this.hovered === r.key);
    const line = v_flex().id("nawaban-row-" + r.key).flex_none().p(CARD_PAD).gap(SPACE.s).rounded(RADIUS.card)
      .when(!selected, (el) => el.hover((s) => s.bg(INK.cardHover)))
      .on_hover((on, cx) => this.noteHover(r.key, on, cx))
      .when(reachable, (el) => el.cursor_pointer().on_click((_e, cx) => this.clickRow(r, cx)))
      .when(Boolean(r.meta), (el) => el.child(h_flex().gap(SPACE.m).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.meta).text_color(INK.meta).child(r.meta))
        .when(Boolean(r.tag), (el) => el.child(this.tag(r.tag, r.tagColor)))))
      .child(h_flex().gap(SPACE.m).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).text_color(r.faded ? INK.dim : INK.title).child(r.title))
        .when(goShown, (el) => el.child(this.goLabel(r)))
        .when(!goShown && Boolean(r.side), (el) => el.child(div().flex_none().text_size(TYPE.meta).text_color(r.sideColor).child(r.side))))
      .when(Boolean(r.why), (el) => el.child(div().truncate().text_size(TYPE.meta).text_color(INK.meta).child(r.why)));
    return [this.card()
      .when(selected, (el) => el.bg(INK.cardSelected).border_color(INK.cardSelectedEdge))
      .when(Boolean(r.accent), (el) => el.child(this.accent(r)))
      .child(this.withFactsOnHover(line, r))
      .when(keyboard && selected, (el) => el.child(this.factsBelow(r)))
      .children(below)];
  }

  decisionLines(r, keyboard, orchestrator, w) {
    const open = Boolean(r.card) && this.openCard === r.key;
    return this.row(r, keyboard, open ? [this.cardDetail(r.card, orchestrator, w.cards)] : []);
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
    const body = v_flex().id("nawaban-card-" + c.key).flex_none().px(CARD_PAD).pb(CARD_PAD).gap(SPACE.l)
      .text_size(TYPE.meta).line_height(CARD_LINE_H + "px").text_color(INK.muted);
    if (said?.final) return body.child(div().whitespace_normal().child(said.text));
    const needsOrchestrator = c.kind !== "talk";
    const part = (text, color) => div().text_size(TYPE.label).text_color(color).whitespace_normal().child(text);
    return body
      .child(div().h(1).bg(INK.cardEdge))
      .child(this.labelled(cw.decision, part(c.decision, INK.foreground)))
      .child(this.labelled(cw.kr, part(c.kr, INK.value)))
      .child(this.labelled(cw.context, part(c.context, INK.value)))
      .child(this.labelled(cw.progress,
        div().max_h(PROGRESS_LINES_SHOWN * CARD_LINE_H).overflow_hidden().whitespace_normal().child(c.progress ?? cw.noProgress)))
      .child(v_flex().gap(SPACE.s + SPACE.xs).children(c.options.map((opt) => this.optionButton(c, opt, c.kind === "pick"))))
      .child(h_flex().gap(SPACE.s + SPACE.xs).items_start().child(div().flex_none().text_color(INK.dim).child(cw.rec))
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(INK.foreground).child(c.rec)))
      .when(needsOrchestrator && !orchestrator, (el) => el.child(div().text_color(INK.amberText).child(cw.noOrchestrator)))
      .when(Boolean(said), (el) => el.child(div().text_color(INK.red).child(said.text)))
      .child(h_flex().gap(SPACE.m).items_center().flex_wrap().children(this.cardActions(c, orchestrator, cw))
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
    return v_flex().gap(SPACE.xs).child(div().text_size(TYPE.meta).text_color(INK.dim).child(label)).child(content);
  }

  button(id, label, primary, disabled, act) {
    return h_flex().id(id).flex_none().h(BUTTON_H).px(SPACE.l).items_center().rounded(RADIUS.control).text_size(TYPE.label)
      .when(primary, (el) => el.bg(INK.foreground).text_color(INK.canvas).font_semibold())
      .when(!primary, (el) => el.border_1().border_color(INK.control).text_color(INK.muted))
      .when(disabled, (el) => el.opacity(DISABLED_OPACITY))
      .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => { act(cx); cx.notify(); }))
      .child(label);
  }

  optionButton(c, opt, pickable) {
    const on = pickable && this.picked[this.answerKey(c)] === opt.key;
    return v_flex().id("nawaban-option-" + c.key + "-" + opt.key).flex_none().px(SPACE.l).py(SPACE.m).gap(SPACE.xs).rounded(RADIUS.control).border_1()
      .border_color(on ? INK.sky : INK.cardEdge)
      .when(on, (el) => el.bg(INK.selected))
      .when(pickable && !on, (el) => el.cursor_pointer().hover((s) => s.bg(INK.hover)))
      .when(pickable, (el) => el.on_click((_e, cx) => { this.picked = { ...this.picked, [this.answerKey(c)]: opt.key }; cx.notify(); }))
      .child(div().text_size(TYPE.label).text_color(INK.title).whitespace_normal().child(opt.key + " · " + opt.text))
      .when(Boolean(opt.note), (el) => el.child(div().text_size(TYPE.meta).text_color(INK.dim).child(opt.note)));
  }

  incompleteLine(incomplete, orchestrator, w) {
    const state = !incomplete.unreturned.length ? "returned" : orchestrator ? "returning" : "stuck";
    return div().flex_none().px(SPACE.s).text_size(TYPE.meta).text_color(INK.dim).whitespace_normal()
      .child(w.cards.incomplete(incomplete.ids, state));
  }

  okrSection(okr, objectives, keyboard, o) {
    return this.section(this.sectionHeader(o.tally(okr.met, okr.total, okr.measured), "", INK.title),
      objectives.map((x) => this.card().p(SPACE.s).gap(SPACE.xs).children(x.ob.standing === "met"
        ? [this.quietObjective(x, o), ...x.met.flatMap((r) => this.krLine(r, keyboard, o, true))]
        : [this.objectiveHeading(x.ob, o), ...x.krs.flatMap((r) => this.krLine(r, keyboard, o, false)),
          ...(x.ob.untestedKrs.length ? [this.fold(x.untestedRow, x.untestedOpen, o.untestedFolded(x.ob.untestedKrs.length)),
            ...x.untested.flatMap((r) => this.krLine(r, keyboard, o, true))] : []),
          ...(x.ob.metKrs.length ? [this.fold(x.foldRow, x.open, o.metFolded(x.ob.metKrs.length)), ...x.met.flatMap((r) => this.krLine(r, keyboard, o, true))] : [])])));
  }

  tabBar(tab, badges, w) {
    return h_flex().flex_none().mx(SPACE.l).mt(SPACE.l).p(SPACE.xs).gap(SPACE.xs).rounded(RADIUS.control)
      .bg(INK.card).border_1().border_color(INK.cardEdge)
      .children(TABS.map((t) => this.tabLabel(t, t === tab, badges[t], w)));
  }

  tabLabel(t, on, badge, w) {
    return h_flex().id("nawaban-tab-" + t).flex_1().min_w(0).h(SEGMENT_H).gap(SPACE.s + SPACE.xs).items_center().justify_center()
      .rounded(RADIUS.segment).cursor_pointer().text_size(TYPE.label)
      .when(on, (el) => el.bg(INK.segment).text_color(INK.foreground).font_semibold())
      .when(!on, (el) => el.text_color(INK.meta).hover((s) => s.text_color(INK.foreground)))
      .on_click((_e, cx) => { this.pickTab(t); cx.notify(); })
      .child(div().min_w(0).truncate().child(w.tabs[t]))
      .when(Boolean(badge), (el) => el.child(div().flex_none().text_size(TYPE.meta).text_color(BADGE_COLOR[badge.tone]).child(badge.text)));
  }

  quietLine(text) {
    return div().flex_none().h(ROW_H).px(SPACE.s).flex().items_center().text_size(TYPE.label).text_color(INK.dim).child(text);
  }

  objectiveHeading(ob, o) {
    return h_flex().flex_none().px(SPACE.m).pt(SPACE.m).pb(SPACE.s).gap(SPACE.l).items_baseline()
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.heading).font_semibold().text_color(INK.foreground).child(ob.name))
      .when(Boolean(ob.rulers), (el) => el.child(div().flex_none().text_size(TYPE.meta).text_color(INK.dim).child(ob.rulers)))
      .when(Boolean(ob.scoring), (el) => el.child(div().flex_none().text_size(TYPE.meta).text_color(INK.dim).child(ob.scoring)))
      .child(div().flex_none().text_size(TYPE.meta).font_medium().text_color(OBJECTIVE_TALLY_COLOR[ob.standing]).child(ob.met + "/" + ob.total));
  }

  quietObjective(x, o) {
    return this.foldRow(x.foldRow, h_flex().flex_none().h(ROW_H).px(SPACE.m).gap(SPACE.l).items_center()
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(INK.muted).child(x.ob.name))
      .child(div().flex_none().text_size(TYPE.meta).font_medium().text_color(OBJECTIVE_TALLY_COLOR.met).child(o.allMet + " " + x.ob.met + "/" + x.ob.total)));
  }

  fold(key, open, label) {
    return this.foldRow(key, h_flex().flex_none().h(GROUP_HEADER_H).px(SPACE.m).items_center().text_size(TYPE.meta)
      .text_color(INK.dim).hover((s) => s.text_color(INK.muted)).child((open ? "▾ " : "▸ ") + label));
  }

  foldRow(key, line) {
    const selected = key === this.selectedKey;
    return line.id("nawaban-" + key).rounded(RADIUS.control).cursor_pointer()
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(INK.hover)))
      .on_click((_e, cx) => this.clickGroup({ key, group: groupOfKey(key) }, cx));
  }

  krLine(r, keyboard, o, quiet) {
    const k = r.kr, selected = r.key === this.selectedKey, fill = krFill(k);
    const line = v_flex().id("nawaban-row-" + r.key).flex_none().p(SPACE.m).gap(SPACE.s + SPACE.xs).rounded(RADIUS.control)
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(INK.hover)))
      .on_hover((on, cx) => this.noteHover(r.key, on, cx))
      .child(h_flex().gap(SPACE.s).items_baseline()
        .child(div().min_w(0).truncate().text_size(TYPE.label).text_color(quiet || !k.measured ? INK.muted : INK.value).child(k.name))
        .when(Boolean(k.kind), (el) => el.child(div().flex_none().text_size(TYPE.meta).text_color(INK.dim).child(k.kind))))
      .when(fill != null, (el) => el.child(this.bar(fill, GAP_COLOR[k.status])))
      .child(this.krReading(k, o, quiet));
    return [this.withFactsOnHover(line, r), ...(keyboard && selected ? [this.factsBelow(r)] : [])];
  }

  bar(fill, color) {
    return div().flex_none().w_full().h(BAR_H).rounded(RADIUS.bar).bg(INK.track)
      .child(div().h(BAR_H).w(Math.round(fill * 100) + "%").rounded(RADIUS.bar).bg(color));
  }

  krReading(k, o, quiet) {
    const dim = (text) => div().flex_none().text_color(INK.dim).child(text);
    if (!k.measured) {
      return h_flex().gap(SPACE.s).text_size(TYPE.meta).child(div().flex_none().text_color(GAP_COLOR[k.status]).child(o.status[k.status] + " / " + o.target + " " + k.target))
        .when(Boolean(k.score), (el) => el.child(dim("· " + k.score)));
    }
    return h_flex().flex_wrap().items_baseline().gap(SPACE.s).text_size(TYPE.meta)
      .child(div().flex_none().text_size(quiet ? TYPE.label : TYPE.body).when(!quiet, (el) => el.font_semibold())
        .text_color(k.status === "missed" ? INK.red : INK.value).child(k.value))
      .child(dim("/ " + o.target + " " + k.target))
      .when(Boolean(k.gap), (el) => el.child(dim("· " + o.variance)).child(div().flex_none().text_color(GAP_COLOR[k.status]).child(k.gap)))
      .child(dim("·")).child(div().flex_none().text_color(GAP_COLOR[k.status]).child(o.status[k.status]))
      .when(Boolean(k.day), (el) => el.child(dim("· " + o.asOfShort + " " + k.day)))
      .when(Boolean(k.interval), (el) => el.child(dim("· " + k.interval)))
      .when(Boolean(k.score), (el) => el.child(dim("· " + k.score)))
      .when(Boolean(k.series), (el) => el.child(dim("· " + k.series)));
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
    return h_flex().id("nawaban-" + s.key).flex_none().h(GROUP_HEADER_H).px(SPACE.s).gap(SPACE.m).items_center().rounded(RADIUS.control).cursor_pointer()
      .text_size(TYPE.label).font_semibold().text_color(s.open || pointed ? INK.title : INK.meta)
      .when(selected, (el) => el.bg(INK.selected))
      .when(!selected, (el) => el.hover((st) => st.bg(INK.hover)))
      .on_hover((on, cx) => this.noteHover(s.key, on, cx))
      .on_click((_e, cx) => this.clickGroup(s, cx))
      .child(div().flex_none().child(w.groups[s.group]))
      .child(this.tag(String(s.count), INK.muted, COUNT_H))
      .child(div().flex_1())
      .child(div().size(CHEVRON).flex_none()
        .when(pointed, (el) => el.child(svg(HERDR_ICON(s.open ? "chevron-down" : "chevron-right")).size(CHEVRON))));
  }

  moreRow(s, w) {
    const selected = this.selectedKey === moreKey(s.group);
    return h_flex().id("nawaban-more-" + s.group).flex_none().h(GROUP_HEADER_H).px(SPACE.s).items_center().rounded(RADIUS.control).cursor_pointer()
      .text_size(TYPE.meta).text_color(INK.dim)
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
      .trigger(h_flex().id("nawaban-more").size(ICON_BUTTON).flex_none().items_center().justify_center().rounded(RADIUS.segment)
        .cursor_pointer().text_color(INK.dim).hover((s) => s.bg(INK.hover).text_color(INK.foreground))
        .child(svg(ICON("more")).size(ICON_SIZE).flex_none()))
      .content(this.menu("nawaban-lang", [
        { key: "zh", label: "中文", on: this.lang === "zh" },
        { key: "en", label: "English", on: this.lang === "en" },
      ], (lang) => this.pickLang(lang), w.language));
  }

  closeButton(el) {
    return el.child(h_flex().id("nawaban-close").size(ICON_BUTTON).flex_none().items_center()
      .justify_center().rounded(RADIUS.segment).cursor_pointer().text_color(INK.dim).hover((s) => s.bg(INK.hover).text_color(INK.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => closeOverlay(props().overlay))
      .child("✕"));
  }

  header(w, windows, elsewhere) {
    const openedAsOverlay = Boolean(props()?.overlay);
    return h_flex().h(HEADER_H).flex_none().pl(SPACE.l + SPACE.xs).pr(SPACE.m).gap(SPACE.m).items_center().border_b_1().border_color(INK.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(INK.title).child(this.projectKey()))
      .child(div().flex_none().text_size(TYPE.meta).text_color(INK.dim).child(w.windows(windows) + " · " + w.elsewhere(elsewhere)))
      .child(this.languageMenu(w))
      .when(openedAsOverlay, (el) => this.closeButton(el));
  }

  menu(id, items, pick, title) {
    return v_flex().id(id).w(MENU_W).mt(SPACE.s).p(SPACE.s).gap(SPACE.xs).rounded(RADIUS.control)
      .bg(INK.popover).border_1().border_color(INK.border).text_size(TYPE.label)
      .child(div().h(MENU_TITLE_H).px(SPACE.m).flex().items_center().text_size(TYPE.meta).text_color(INK.muted).child(title))
      .children(items.map((x) => h_flex().id(id + "-" + x.key).h(MENU_ITEM_H).flex_none().px(SPACE.m).gap(SPACE.m).items_center().rounded(RADIUS.segment)
        .cursor_pointer().hover((s) => s.bg(INK.hover))
        .on_click((_e, cx) => { pick(x.key); cx.notify(); })
        .child(div().size(ICON_SIZE).flex_none().when(x.on, (el) => el.child(svg(HERDR_ICON("check")).size(ICON_SIZE).text_color(INK.foreground))))
        .child(div().flex_1().min_w(0).truncate().child(x.label))));
  }
}
