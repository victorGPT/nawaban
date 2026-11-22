const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = DAY * MS_PER_SECOND;
const ISSUE_STILL_MOVING_FOR = DAY;

export function projectFor(gitCommonDir, projects) {
  const name = repoName(gitCommonDir);
  return (projects?.projects ?? []).some((p) => p.name === name) ? name : null;
}

export function repoName(gitCommonDir) {
  const [checkout, gitDir] = gitCommonDir.trim().split("/").filter(Boolean).slice(-2);
  return gitDir ? checkout : null;
}

export const BOARD_PROJECTS = new Set(["nawaban", "bzkanbanv2", "huafa"]);
const onThisComputer = (machine) => machine == null;
export const cliFor = (project, machine = null) => (onThisComputer(machine) && BOARD_PROJECTS.has(project) ? "board" : "old");

const SUPPORTED_LANGS = ["zh", "en"];
const prefersChinese = (system) => /^zh/i.test(String(system ?? "").replace(/[\s("]/g, ""));
export function resolveLang(saved, system) {
  if (SUPPORTED_LANGS.includes(saved)) return saved;
  return prefersChinese(system) ? "zh" : "en";
}

export const folderOf = (path) => path.slice(0, path.lastIndexOf("/"));
const WRITE_AHEAD_LOG_SUFFIX = "-wal";
const isBoardFileOrItsLog = (path, db) => path === db || path === db + WRITE_AHEAD_LOG_SUFFIX;
const isWatchedFolderItself = (path, db) => path === folderOf(db);
export const boardChanged = (paths, db) => paths.some((p) => isBoardFileOrItsLog(p, db) || isWatchedFolderItself(p, db));

export const OKR_FOLDER_IN_REPO = "docs/agents";
const OKR_FILE = "okr.toml";
export const okrChanged = (paths, dir) => paths.some((p) => p === dir || p.endsWith("/" + OKR_FILE));
const CLI_REFUSAL_FOR_MISSING_OKR_FILE = "没有 " + OKR_FOLDER_IN_REPO + "/" + OKR_FILE;
const READ_WITHOUT_OBJECTIVES = { objectives: [] };
export const okrReadingOfFailure = (e) => (String(e?.message ?? "").startsWith(CLI_REFUSAL_FOR_MISSING_OKR_FILE) ? READ_WITHOUT_OBJECTIVES : null);
export const hasNoObjective = (okr) => Array.isArray(okr?.objectives) && okr.objectives.length === 0;

const isDone = (t) => t.status === "done";
const isHeld = (t) => t.session != null;
const isAsking = (t) => t.waiting != null;
const isLive = (k) => k.state === "live";
const isGithubBoard = (board) => board?.tracker === "github";
export const canGo = (x) => x.focus != null || Boolean(x.url);

const allTasks = (board) => (board?.columns ?? []).flatMap((c) => c.tasks ?? []);
const openTasks = (board) => (board?.columns ?? []).filter((c) => c.key !== "done").flatMap((c) => c.tasks ?? []);
const newestActivityFirst = (x, y) => y.active_at - x.active_at;
const newestHerdrChangeFirst = (x, y) => y.seq - x.seq;

const herdrSaysBlocked = (status) => status === "blocked";
const herdrSaysNeedsYou = (status) => status === "blocked" || status === "error";
const herdrStateShownAsIs = (status) => status === "done" || status === "working";

function windowStateOf(agent, asking, task) {
  if (asking || herdrSaysBlocked(agent.status)) return "waiting";
  if (task && agent.status === "idle") return "stopped";
  if (herdrStateShownAsIs(agent.status)) return agent.status;
  return "idle";
}

const NO_KNOWN_START = null;
const NO_HERDR_SEQ = 0;

function windowOf(agent, open, nameOf, now, lang) {
  const words = WINDOW_WORDS[lang];
  const mine = open.filter((t) => t.terminal === agent.address);
  const asking = mine.find(isAsking);
  const task = asking ?? mine[0];
  const blockedByHerdr = !asking && herdrSaysBlocked(agent.status);
  const state = windowStateOf(agent, asking, task);
  const since = blockedByHerdr ? NO_KNOWN_START : task?.active_at ?? NO_KNOWN_START;
  return { name: nameOf(agent), ...(state === "waiting" && { question: asking?.waiting ?? words.confirm }),
    doing: blockedByHerdr ? agent.title : task?.title ?? agent.title, state, label: words[state],
    duration: since == null ? null : span(now - since, lang, Boolean(asking)),
    focus: agent.address, ...(task?.url && { url: task.url }), seq: agent.seq, since };
}

function strayCardOf(task, agents, terminals, nameOf, now, lang) {
  const away = agents.find((a) => a.address === task.terminal) ?? terminals.find((k) => isLive(k) && k.address === task.terminal);
  return { name: away ? nameOf(away) : task.id, question: task.waiting, doing: task.title, state: "waiting",
    label: WINDOW_WORDS[lang].waiting, duration: span(now - task.active_at, lang, true), focus: away?.address ?? null,
    url: task.url ?? null, seq: NO_HERDR_SEQ, since: task.active_at };
}

const UNTIMED_WAITS_LAST = Infinity;
const longestWaitingFirst = (x, y) => (x.since ?? UNTIMED_WAITS_LAST) - (y.since ?? UNTIMED_WAITS_LAST) || newestHerdrChangeFirst(x, y);
const withoutSortKeys = ({ seq, since, ...w }) => w;
const ROW_ORDER = ["stopped", "done", "working"];

const waitingInOtherProjects = (projects, project) =>
  (projects?.projects ?? []).reduce((n, p) => n + (p.name === project ? 0 : p.waiting ?? 0), 0);

export function windowsView({ agents, space, board, now, lang, projects, project, terminals = [] }) {
  const nameOf = namer(terminals);
  const open = openTasks(board).sort(newestActivityFirst);
  const here = agents.filter((a) => a.space === space);
  const windows = here.map((a) => windowOf(a, open, nameOf, now, lang));
  const inNoWindowHere = (t) => !here.some((a) => a.address === t.terminal);
  const strays = open.filter((t) => isAsking(t) && inNoWindowHere(t)).map((t) => strayCardOf(t, agents, terminals, nameOf, now, lang));
  const waiting = [...windows, ...strays].filter((w) => w.state === "waiting").sort(longestWaitingFirst).map(withoutSortKeys);
  const rows = ROW_ORDER.flatMap((s) => windows.filter((w) => w.state === s).sort(newestHerdrChangeFirst)).map(withoutSortKeys);
  const idle = windows.filter((w) => w.state === "idle").map((w) => w.name);
  return { waiting, rows, idle: { count: idle.length, names: idle }, otherWaiting: waitingInOtherProjects(projects, project) };
}

const isBareTabIndex = (tabName) => /^\d+$/.test(tabName);
const namer = (terminals) => {
  const names = new Map(terminals.map((k) => [k.address, k.name]));
  return (a) => names.get(a.address) || (isBareTabIndex(a.tab_name) ? "" : a.tab_name) || a.title;
};

const withoutQuestions = (board) => ({ ...board,
  columns: board.columns.map((c) => ({ ...c, tasks: (c.tasks ?? []).map((t) => ({ ...t, waiting: null })) })) });

const TERMINAL_NUMBER_RADIX = 36;
const TERMINAL_PREFIX = "t";
const startOrder = (k) => parseInt(k.address.split("/").pop().slice(TERMINAL_PREFIX.length), TERMINAL_NUMBER_RADIX);
const byStartOrder = (x, y) => startOrder(x) - startOrder(y);

function herdrTree(agents, space, live) {
  const descendants = (address, seen) => live.filter((k) => k.parent === address && !seen.has(k.address))
    .flatMap((k) => (seen.add(k.address), [k, ...descendants(k.address, seen)]));
  const subtrees = agents.filter((a) => a.space === space).map((a) => [a.address, descendants(a.address, new Set([a.address]))]);
  const insideSomeSubtree = new Set(subtrees.flatMap(([, below]) => below.map((k) => k.address)));
  const isTopmostLeader = ([address, below]) => below.length && !insideSomeSubtree.has(address);
  const childrenOf = new Map(subtrees.filter(isTopmostLeader).map(([address, below]) => [address, below.sort(byStartOrder)]));
  const leaderOf = new Map([...childrenOf].flatMap(([leader, below]) => below.map((k) => [k.address, leader])));
  return { childrenOf, leaderOf };
}

function boardContext(args) {
  const github = isGithubBoard(args.board);
  const terminals = args.terminals ?? [];
  const board = github ? matchIssues(args.board, terminals) : args.board;
  const live = terminals.filter(isLive);
  const tasks = allTasks(board);
  const agentAt = (terminal) => args.agents.find((a) => a.address === terminal);
  return { ...args, board, github, terminals, live, tasks, nameOf: namer(terminals),
    byId: new Map(tasks.map((t) => [t.id, t])), agentAt,
    windowAt: (terminal) => agentAt(terminal) ?? live.find((k) => k.address === terminal),
    ...herdrTree(args.agents, args.space, live) };
}

const questionsAskedOnBoard = (c) => (c.github ? { ...c, board: withoutQuestions(c.board) } : c);

function taskState(c, t) {
  if (isDone(t)) return "done";
  if (isAsking(t)) return "waiting";
  if (!isHeld(t)) return "todo";
  const window = t.terminal && c.windowAt(t.terminal);
  if (herdrSaysNeedsYou(window?.status)) return "waiting";
  return t.terminal && (!window || window.status === "idle") ? "stopped" : "current";
}

const rootOf = (c, t) => {
  while (c.byId.has(t.parent)) t = c.byId.get(t.parent);
  return t;
};

const spokesmanOf = (tickets, states, root) =>
  tickets[states.indexOf("waiting")] ?? tickets[states.indexOf("stopped")] ?? tickets[states.indexOf("current")] ?? root;
const isHeldState = (state) => state === "current" || state === "stopped" || state === "waiting";

function specState(c, root, tickets, states, lead) {
  const allTicketsDone = tickets.length && states.every((s) => s === "done");
  return isDone(root) || allTicketsDone ? "done" : taskState(c, lead);
}

function sinceOf(state, root, tickets, lead) {
  if (state === "done") return root.done_at ?? Math.max(...tickets.map((t) => t.done_at ?? 0));
  if (state === "current") return lead.claimed_at;
  if (state === "stopped" || state === "waiting") return lead.active_at;
  return null;
}

function itemOf(c, root) {
  const tickets = specOrder(c.tasks.filter((t) => t !== root && rootOf(c, t) === root));
  const states = tickets.map((t) => taskState(c, t));
  const lead = spokesmanOf(tickets, states, root);
  const state = specState(c, root, tickets, states, lead);
  const held = isHeldState(state);
  const window = held && lead.terminal ? c.windowAt(lead.terminal) : null;
  return { id: root.id, title: root.title, state, at: sinceOf(state, root, tickets, lead),
    gone: state === "stopped" && !window, asking: isAsking(lead),
    note: held ? lead.progress?.body ?? null : null, focus: window ? lead.terminal : null,
    spec: tickets.length ? { done: states.filter((s) => s === "done").length, total: tickets.length } : null,
    url: root.url ?? null, active: Math.max(...[root, ...tickets].map((t) => t.active_at ?? 0)) };
}

const ISSUE_NAME = /^gh-(\d+)/;
const issueNamedBy = (name) => ISSUE_NAME.exec(name ?? "");
const childName = (k) => k.name || k.program?.name || k.address;

const isUnclaimedIssue = (t) => !isDone(t) && !isHeld(t) && !t.terminal && !isAsking(t);
function issueTaskItem(c, t) {
  if (isUnclaimedIssue(t)) return { ...issueItem(t, null, c.now), state: "todo", at: null };
  const window = t.terminal ? c.windowAt(t.terminal) : null;
  return { ...issueItem(t, window?.status, c.now), focus: window ? t.terminal : null };
}

const taskItems = (c) => (c.github ? c.tasks.map((t) => issueTaskItem(c, t))
  : c.tasks.filter((t) => rootOf(c, t) === t).map((root) => itemOf(c, root)));

export const TASK_GROUPS = ["stopped", "working", "todo", "done"];
const TASK_GROUP_OF_STATE = { waiting: "stopped", stopped: "stopped", current: "working", pushing: "working", todo: "todo", done: "done" };
const latestDoneFirst = (x, y) => (y.at ?? 0) - (x.at ?? 0);
const mostRecentlyActiveFirst = (x, y) => y.active - x.active;
const ORDER_IN_GROUP = { done: latestDoneFirst };

const alreadyOnACard = (cards) => {
  const carded = new Set(cards.map((card) => card.focus).filter((f) => f != null));
  return (x) => x.state === "waiting" && (x.asking || carded.has(x.focus));
};

function taskGroups(c, items, cards) {
  const onACard = alreadyOnACard(cards);
  const listed = items.filter((x) => !onACard(x));
  return TASK_GROUPS.map((group) => ({ group, items: listed.filter((x) => TASK_GROUP_OF_STATE[x.state] === group)
    .sort(ORDER_IN_GROUP[group] ?? mostRecentlyActiveFirst)
    .map(({ active, asking, ...x }) => ({ key: "task:" + x.id, ...x, where: x.focus == null ? null : c.nameOf(c.windowAt(x.focus)) })) }))
    .filter((g) => g.items.length);
}

function panelessBlockedCards(c, items) {
  if (!c.github) return [];
  const words = WINDOW_WORDS[c.lang];
  const isPanelessBlockedChild = (k) => c.leaderOf.has(k.address) && !c.agentAt(k.address) && herdrSaysBlocked(k.status);
  return c.live.filter(isPanelessBlockedChild).flatMap((k) => {
    const x = items.find((i) => i.focus === k.address);
    return x ? [{ name: childName(k), question: words.confirm, doing: x.title, state: "waiting", label: words.waiting, duration: null,
      focus: x.focus, ...(x.url && { url: x.url }) }] : [];
  });
}

export function panelView(args) {
  const c = boardContext(args);
  const { waiting: asking, otherWaiting } = windowsView(questionsAskedOnBoard(c));
  const items = taskItems(c);
  const cards = [...asking, ...panelessBlockedCards(c, items)].map((card, i) => ({ key: "card:" + i, ...card }));
  return { waiting: cards, tasks: taskGroups(c, items, cards), otherWaiting };
}

const openBlockersIn = (open) => (t) => (t.blocked_by ?? []).some((b) => open.some((o) => o.id === b));
const FIRST_IN_A_CYCLE = 0;
const specOrder = (tickets) => {
  const out = tickets.filter(isDone).sort((x, y) => x.done_at - y.done_at);
  const open = tickets.filter((t) => !isDone(t));
  while (open.length) {
    const unblocked = open.findIndex((t) => !openBlockersIn(open)(t));
    out.push(...open.splice(Math.max(unblocked, FIRST_IN_A_CYCLE), 1));
  }
  return out;
};

const issueNumber = (id) => id.slice(1);

export const GROUP_OPEN_BY_DEFAULT = new Set(["stopped"]);
export const DONE_SHOWN = 5;
const GROUP_WITH_REASONS = "stopped";
const GROUP_KEY_PREFIX = "group:";
export const MORE_DONE_KEY = "more:done";
export const groupOfKey = (key) => (key?.startsWith(GROUP_KEY_PREFIX) ? key.slice(GROUP_KEY_PREFIX.length) : null);
export const foldKey = (project, group) => (project ?? "") + ":" + group;
export const isGroupOpen = (folds, project, group) => folds?.[foldKey(project, group)] ?? GROUP_OPEN_BY_DEFAULT.has(group);
const oneLine = (text) => text.replace(/\s+/g, " ").trim();
const reasonOf = (x, w) => oneLine([x.gone && w.gone, x.note].filter(Boolean).join(" · "));

export function taskSections(groups, { folds, project, allDone, lang }) {
  const w = WINDOW_WORDS[lang];
  return groups.map(({ group, items }) => {
    const capped = group === "done" && items.length > DONE_SHOWN;
    const shown = capped && !allDone ? items.slice(0, DONE_SHOWN) : items;
    return { key: GROUP_KEY_PREFIX + group, group, count: items.length, open: isGroupOpen(folds, project, group),
      items: shown.map((x) => (group === GROUP_WITH_REASONS ? { ...x, why: reasonOf(x, w) || null } : x)),
      more: capped ? { hidden: allDone ? 0 : items.length - DONE_SHOWN } : null };
  });
}

const keysUnder = (s) => (s.open ? [...s.items.map((x) => x.key), ...(s.more ? [MORE_DONE_KEY] : [])] : []);
export const panelKeys = (decisions, krs, sections) => [...decisions, ...krs, ...sections.flatMap((s) => [s.key, ...keysUnder(s)])];

export const pendingView = (board) => openTasks(board)
  .filter((t) => t.pending).sort((x, y) => x.pending.at - y.pending.at || issueNumber(x.id) - issueNumber(y.id))
  .map((t) => ({ key: "pending:" + t.id, id: t.id, title: t.title, brief: t.pending.brief ? oneLine(t.pending.brief) : null, url: t.url ?? null }));

const issueTerminalsByName = (live) => new Map(live.flatMap((k) => {
  const named = issueNamedBy(k.name);
  return named ? [["#" + named[1], k.address]] : [];
}));

const matchIssues = (board, terminals) => {
  const live = terminals.filter(isLive), alive = new Set(live.map((k) => k.address));
  const claimed = new Set(allTasks(board).map((t) => t.terminal).filter((terminal) => alive.has(terminal)));
  const byName = issueTerminalsByName(live.filter((k) => !claimed.has(k.address)));
  const terminalOf = (t) => (alive.has(t.terminal) ? t.terminal : byName.get(t.id) ?? t.terminal);
  return { ...board, columns: board.columns.map((c) => ({ ...c, tasks: (c.tasks ?? []).map((t) => ({ ...t, terminal: terminalOf(t) })) })) };
};

function issueState(t, status, now) {
  if (isDone(t)) return "done";
  if (isAsking(t) || herdrSaysNeedsYou(status)) return "waiting";
  if (status === "working") return "current";
  return now - t.active_at < ISSUE_STILL_MOVING_FOR ? "pushing" : "stopped";
}

const issueSince = (t, state) => (state === "done" ? t.done_at : state === "current" ? t.claimed_at : state === "stopped" ? t.active_at : null);

const issueItem = (t, status, now) => {
  const state = issueState(t, status, now);
  return { id: t.id, title: t.title, state, at: issueSince(t, state), gone: false, asking: false,
    note: t.progress?.body ?? null, focus: null, spec: null, url: t.url ?? null, active: t.active_at };
};


const SPAN_UNITS = [
  { below: HOUR, unit: MINUTE, zh: "分钟", en: "m" },
  { below: DAY, unit: HOUR, zh: "小时", en: "h" },
  { below: Infinity, unit: DAY, zh: "天", en: "d" }];
const span = (seconds, lang, onCard) => {
  if (seconds < MINUTE) return lang === "zh" ? "刚刚" : "now";
  const { unit, zh, en } = SPAN_UNITS.find((u) => seconds < u.below);
  const n = Math.floor(seconds / unit);
  return lang === "zh" && onCard ? n + " " + zh : n + en;
};

const TODAY = 0;
const YESTERDAY = 1;
const localMidnight = (at) => new Date(at * MS_PER_SECOND).setHours(0, 0, 0, 0);
const daysAgo = (at, now) => Math.round((localMidnight(now) - localMidnight(at)) / MS_PER_DAY);
const clockTime = (at) => {
  const d = new Date(at * MS_PER_SECOND);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
};
const dayOf = (at, now, w) => {
  const ago = daysAgo(at, now);
  return ago === TODAY ? null : ago === YESTERDAY ? w.yesterday : decisionDate(at);
};

export function sinceLabel({ state, at }, now, lang) {
  if (at == null) return "";
  if (state === "done") return dayOf(at, now, WINDOW_WORDS[lang]) ?? clockTime(at);
  return span(now - at, lang, true);
}

const pad = (n) => String(n).padStart(2, "0");
const calendarMonth = (d) => d.getMonth() + 1;

export const decisionDate = (at) => {
  const d = new Date(at * MS_PER_SECOND);
  return pad(calendarMonth(d)) + "-" + pad(d.getDate());
};

export const WINDOW_WORDS = {
  zh: { waiting: "等你", pushing: "在推", stopped: "停了", done: "完成", working: "在干", idle: "空闲", todo: "还没动", yesterday: "昨天", confirm: "在等你确认",
    windows: (n) => `${n} 个窗口`, elsewhere: (n) => (n ? `其他项目 ${n} 件等你` : "其他项目没有等你的"),
    gone: "窗口已关，任务还拿着没交还", none: "这个 space 没有 agent 窗口", loading: "读取中…", error: "读不到看板", language: "语言",
    decide: "待你决定", groups: { stopped: "停了", working: "在做", todo: "没动", done: "完成" },
    more: (n) => `再显示 ${n} 条`, less: "收起", go: "去窗口", issue: "去 GitHub",
    facts: { id: "编号", question: "问题", note: "进展", window: "窗口", since: "多久", spec: "票" } },
  en: { waiting: "Waiting", pushing: "Moving", stopped: "Stopped", done: "Done", working: "Working", idle: "Idle", todo: "Not started", yesterday: "yesterday", confirm: "Waiting for you to confirm",
    windows: (n) => `${n} window${n === 1 ? "" : "s"}`, elsewhere: (n) => (n ? `${n} waiting elsewhere` : "nothing waiting elsewhere"),
    gone: "Window closed, task still held", none: "No agent windows in this space", loading: "Loading…", error: "Can't read the board", language: "Language",
    decide: "Needs your decision", groups: { stopped: "Stopped", working: "Working", todo: "Not started", done: "Done" },
    more: (n) => `Show ${n} more`, less: "Show less", go: "Go to window", issue: "Open on GitHub",
    facts: { id: "ID", question: "Question", note: "Progress", window: "Window", since: "For", spec: "Tickets" } },
};

const FIRST = 0;
const entryPoint = (keys, delta) => keys[delta > 0 ? FIRST : keys.length - 1];
const clampIndex = (keys, i) => Math.min(keys.length - 1, Math.max(FIRST, i));
export function moveSelection(keys, key, delta) {
  if (!keys.length) return null;
  const at = keys.indexOf(key);
  if (at < 0) return entryPoint(keys, delta);
  return keys[clampIndex(keys, at + delta)];
}

const KEYS = { down: "down", up: "up", enter: "open", escape: "back" };
export const keyCommand = (e) => KEYS[e.keystroke] ?? null;

const OKR_STATES = ["met", "missed", "stale", "untested"];
const KR_STATUS_WORST_FIRST = ["missed", "stale", "untested", "met"];
const OPS = { ">=": "≥", "<=": "≤", ">": ">", "<": "<", "==": "=" };
const TENTHS = 10;
const oneDecimal = (v) => String(Math.round(v * TENTHS) / TENTHS);

const TARGET = /^\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
const parseTarget = (target, unit = "") => {
  const m = TARGET.exec(target ?? "");
  return m ? OPS[m[1]] + " " + m[2] + unit : null;
};

const isMeasured = (k) => k.value != null && k.status !== "untested";
const hasMismatch = (k) => Array.isArray(k.mismatch) && k.mismatch.length > 0;

const krRow = (k, w) => ({ name: k.name, status: OKR_STATES.includes(k.status) ? k.status : "untested",
  value: isMeasured(k) ? oneDecimal(k.value) + (k.unit ?? "") : w.status.untested, target: parseTarget(k.target, k.unit ?? "") ?? k.target ?? "",
  as_of: k.as_of ?? null, source: k.source ?? null, trend: w.trend[k.trend] ?? w.trend.null,
  missed_rounds: k.missed_rounds ?? 0, wait: k.wait ?? null,
  mismatch: hasMismatch(k) ? w.mismatch(k.mismatch.map((m) => m.ticket)) : null });

const worstFirst = (x, y) => KR_STATUS_WORST_FIRST.indexOf(x.status) - KR_STATUS_WORST_FIRST.indexOf(y.status);

const DIRS = ["↑", "↓", "="];
const declaredAny = (n) => n && DIRS.some((d) => n[d] > 0);
const impactLine = (n) => (declaredAny(n) ? DIRS.map((d) => d + (n[d] ?? 0)).join(" ") : null);

function objectiveView(o, w) {
  const krs = (o.krs ?? []).map((k) => krRow(k, w));
  return { name: o.name, met: o.met ?? krs.filter((k) => k.status === "met").length, total: o.total ?? krs.length,
    impacts: impactLine(o.impacts), krs: krs.sort(worstFirst) };
}

export const isoMonthDay = (iso) => iso.slice(5, 10);
const isoHourMinute = (iso) => iso.slice(11, 16);
const isOkrReading = (okr) => okr && Array.isArray(okr.objectives) && okr.objectives.length > 0;

export function okrView(okr, lang) {
  if (!isOkrReading(okr)) return null;
  const w = OKR_WORDS[lang] ?? OKR_WORDS.en;
  const at = okr.last_measured_at;
  return { met: okr.met, total: okr.total, measured: at ? isoMonthDay(at) + " " + isoHourMinute(at) : null,
    objectives: okr.objectives.map((o) => objectiveView(o, w)) };
}

export const OKR_WORDS = {
  zh: { title: "OKR", tally: (met, total, at) => `${met}/${total} 达标${at ? ` · ${at} 量` : ""}`,
    status: { met: "达标", missed: "未达标", stale: "过期", untested: "未测" },
    trend: { closer: "在变好", away: "在变差", flat: "没动", null: "首次读数" },
    target: "目标", value: "现值", asOf: "截至", source: "来源", trendLabel: "走向", rounds: (n) => `连续 ${n} 轮未达标`, wait: "要你做",
    mismatch: (ts) => `预期不符 ${ts.join(" ")}`, noObjective: "这个项目还没有 O" },
  en: { title: "OKR", tally: (met, total, at) => `${met}/${total} met${at ? ` · measured ${at}` : ""}`,
    status: { met: "Met", missed: "Missed", stale: "Stale", untested: "Untested" },
    trend: { closer: "Getting closer", away: "Moving away", flat: "Flat", null: "First reading" },
    target: "Target", value: "Value", asOf: "As of", source: "Source", trendLabel: "Trend", rounds: (n) => `missed ${n} rounds in a row`, wait: "Needs you to",
    mismatch: (ts) => `Not as declared ${ts.join(" ")}`, noObjective: "No Objective for this project yet" },
};
