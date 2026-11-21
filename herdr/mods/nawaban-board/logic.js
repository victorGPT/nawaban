const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = DAY * MS_PER_SECOND;
const DONE_STAYS_IN_GROUP_FOR = DAY;
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

const isDone = (t) => t.status === "done";
const isHeld = (t) => t.session != null;
const neverClaimed = (t) => t.claimed_at == null;
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

const issueByClaimedTerminal = (board) => new Map(allTasks(board).filter((t) => t.terminal)
  .sort((x, y) => isDone(y) - isDone(x)).map((t) => [t.terminal, t.id]));

function readClaimsBeforeMatchingNames(board, terminals) {
  const claimedAt = issueByClaimedTerminal(board);
  return { claimedAt, board: matchIssues(board, terminals) };
}

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
  const { claimedAt, board } = github ? readClaimsBeforeMatchingNames(args.board, terminals) : { claimedAt: new Map(), board: args.board };
  const live = terminals.filter(isLive);
  const tasks = allTasks(board);
  const agentAt = (terminal) => args.agents.find((a) => a.address === terminal);
  return { ...args, board, github, claimedAt, terminals, live, tasks, nameOf: namer(terminals),
    byId: new Map(tasks.map((t) => [t.id, t])), agentAt,
    windowAt: (terminal) => agentAt(terminal) ?? live.find((k) => k.address === terminal),
    ...herdrTree(args.agents, args.space, live) };
}

const questionsAskedOnBoard = (c) => (c.github ? { ...c, board: withoutQuestions(c.board) } : c);

function taskState(c, t) {
  if (isDone(t)) return "done";
  if (!isHeld(t)) return "todo";
  const window = t.terminal && c.windowAt(t.terminal);
  return t.terminal && (!window || window.status === "idle") ? "stopped" : "current";
}

const belongsInGroup = (t, now) => (isDone(t) ? t.done_at >= now - DONE_STAYS_IN_GROUP_FOR : isHeld(t) || neverClaimed(t));

const rootOf = (c, t) => {
  while (c.byId.has(t.parent)) t = c.byId.get(t.parent);
  return t;
};

function leaderTerminalOfSession(c, leader) {
  return c.tasks.find((x) => leader != null && sessionKey(x.session) === leader && c.childrenOf.has(x.terminal))?.terminal;
}

function groupOf(c, t) {
  if (c.leaderOf.has(t.terminal)) return c.leaderOf.get(t.terminal);
  if (c.childrenOf.has(t.terminal)) return t.terminal;
  if (c.github) return null;
  const leader = sessionKey(t.leader ?? t.session);
  return leaderTerminalOfSession(c, leader) ?? leader;
}

const childShowsItsIssueByName = (c, t) => c.github && c.leaderOf.has(t.terminal);
const isOpenTicketHeldByChild = (c, t) => !isDone(t) && isHeld(t) && c.leaderOf.has(t.terminal);

function collectGroups(c) {
  const groups = new Map([...c.childrenOf.keys()].map((leader) => [leader, new Set()]));
  const heldByChild = new Map();
  for (const t of c.tasks) {
    const leader = groupOf(c, t);
    if (leader == null || !belongsInGroup(t, c.now) || childShowsItsIssueByName(c, t)) continue;
    if (!groups.has(leader)) groups.set(leader, new Set());
    groups.get(leader).add(rootOf(c, t));
    if (isOpenTicketHeldByChild(c, t)) heldByChild.set(t.terminal, t);
  }
  return { groups, heldByChild };
}

const UNNAMED_LEADER_ID_LENGTH = 8;
function leaderName(c, leader) {
  const terminal = c.childrenOf.has(leader) ? leader : c.tasks.find((x) => sessionKey(x.session) === leader && x.terminal)?.terminal;
  const agent = c.agentAt(terminal);
  return agent ? c.nameOf(agent) : leader.slice(0, UNNAMED_LEADER_ID_LENGTH);
}

const spokesmanOf = (tickets, states, root) => tickets[states.indexOf("stopped")] ?? tickets[states.indexOf("current")] ?? root;
const isHeldState = (state) => state === "current" || state === "stopped";

function specState(c, root, tickets, states, lead) {
  const allTicketsDone = tickets.length && states.every((s) => s === "done");
  return isDone(root) || allTicketsDone ? "done" : taskState(c, lead);
}

function whoIsOn(lead, leader, state, tickets) {
  const self = sessionKey(lead.session) === leader || lead.terminal === leader;
  if (isHeldState(state)) return self ? "self" : "worker";
  return state === "todo" && !tickets.length ? "worker" : null;
}

function sinceOf(state, root, tickets, lead) {
  if (state === "done") return root.done_at ?? Math.max(...tickets.map((t) => t.done_at ?? 0));
  if (state === "current") return lead.claimed_at;
  if (state === "stopped") return lead.active_at;
  return null;
}

const NEVER_CLAIMED_LAST = Infinity;

function itemOf(c, root, leader) {
  const tickets = specOrder(c.tasks.filter((t) => t !== root && rootOf(c, t) === root));
  const states = tickets.map((t) => taskState(c, t));
  const done = states.filter((s) => s === "done").length;
  const lead = spokesmanOf(tickets, states, root);
  const state = specState(c, root, tickets, states, lead);
  const held = isHeldState(state);
  const all = [root, ...tickets];
  const claims = all.map((t) => t.claimed_at).filter((at) => at != null);
  return { id: root.id, title: root.title, state, at: sinceOf(state, root, tickets, lead),
    gone: state === "stopped" && !c.windowAt(lead.terminal), who: whoIsOn(lead, leader, state, tickets),
    note: held ? lead.progress?.body ?? null : null, focus: held && c.windowAt(lead.terminal) ? lead.terminal : null,
    spec: tickets.length ? { tickets: tickets.map((t) => t.id), segments: states, done, total: tickets.length } : null,
    claimed: claims.length ? Math.min(...claims) : NEVER_CLAIMED_LAST, created_at: root.created_at,
    decisions: all.map((t) => t.decision).filter(Boolean),
    active: Math.max(...all.map((t) => t.active_at)) };
}

const ISSUE_NAME = /^gh-(\d+)/;
const issueNamedBy = (name) => ISSUE_NAME.exec(name ?? "");
const childName = (k) => k.name || k.program?.name || k.address;
const herdrStatusAsItemState = (status) => (status === "working" ? "current" : herdrSaysNeedsYou(status) ? "waiting" : "done");

function issueOfChild(c, k) {
  if (!c.github) return null;
  const named = issueNamedBy(k.name);
  return c.byId.get(c.claimedAt.get(k.address)) ?? (named && c.byId.get("#" + named[1]));
}

function childItem(c, k, leader, heldByChild) {
  const key = leader + "/" + k.address, agent = c.agentAt(k.address), status = agent?.status ?? k.status;
  const placed = { key, name: childName(k), focus: k.address };
  const issue = issueOfChild(c, k);
  if (issue) return { ...issueItem(issue, status, c.now), ...placed };
  if (heldByChild.has(k.address)) return { ...itemOf(c, heldByChild.get(k.address), leader), ...placed };
  return { key, id: k.address, title: childName(k), name: childName(k), state: herdrStatusAsItemState(status),
    at: null, gone: false, who: "worker", note: agent?.title || null, focus: k.address, spec: null, decisions: [], active: 0 };
}

const firstClaimedFirst = (x, y) => x.claimed - y.claimed || x.created_at - y.created_at;
const closedLast = (items) => [...items.filter((x) => !x.closed), ...items.filter((x) => x.closed)];
const newestDecision = (items) => items.flatMap((x) => x.decisions).sort((x, y) => y.at - x.at)[0];
const firstLine = (text) => text.split("\n")[0];
const needsAttention = (item) => item.state === "stopped" || item.state === "waiting";

function groupView(c, leader, roots, heldByChild) {
  const children = c.childrenOf.get(leader) ?? [];
  const shownByChild = new Set(children.filter((k) => heldByChild.has(k.address)).map((k) => rootOf(c, heldByChild.get(k.address))));
  const rest = [...roots].filter((r) => !shownByChild.has(r)).map((r) => itemOf(c, r, leader)).sort(firstClaimedFirst);
  const all = [...children.map((k) => childItem(c, k, leader, heldByChild)), ...rest];
  const numbered = closedLast(all)
    .map(({ claimed, created_at, decisions, active, ...x }, i) => ({ key: leader + "/" + x.id, number: i + 1, ...x }));
  const items = numbered.filter((x) => !x.closed), closed = numbered.filter((x) => x.closed);
  const dispatched = numbered.filter((x) => x.who === "worker").length;
  const last = newestDecision(all);
  return { leader, name: leaderName(c, leader), self: numbered.length - dispatched, dispatched,
    decision: last ? { at: last.at, verdict: firstLine(last.verdict) } : null, items, closed,
    stopped: items.some(needsAttention), active: Math.max(...all.map((x) => x.active)) };
}

const stoppedThenMostRecentlyActive = (x, y) => y.stopped - x.stopped || y.active - x.active;
const withoutGroupSortKeys = ({ stopped, active, ...g }) => g;

function panelessBlockedCards(c, groups) {
  if (!c.github) return [];
  const words = WINDOW_WORDS[c.lang];
  const items = groups.flatMap((g) => [...g.items, ...g.closed]);
  const isPanelessBlockedChild = (k) => c.leaderOf.has(k.address) && !c.agentAt(k.address) && herdrSaysBlocked(k.status);
  return c.live.filter(isPanelessBlockedChild).map((k) => items.find((x) => x.focus === k.address)).filter(Boolean)
    .map((x) => ({ name: x.name, question: words.confirm, doing: x.title, state: "waiting", label: words.waiting, duration: null,
      focus: x.focus, ...(x.url && { url: x.url }) }));
}

function idleRow(c, waiting) {
  const words = WINDOW_WORDS[c.lang];
  const isCard = (a) => waiting.some((card) => card.focus === a.address);
  const isInTree = (a) => c.childrenOf.has(a.address) || c.leaderOf.has(a.address);
  const holdsOpenTask = (a) => c.tasks.some((t) => !isDone(t) && t.terminal === a.address);
  const free = c.agents.filter((a) => a.space === c.space && !isCard(a) && !isInTree(a) && !holdsOpenTask(a))
    .map((a) => (herdrStateShownAsIs(a.status) ? words.withState(c.nameOf(a), words[a.status]) : c.nameOf(a)));
  return { count: free.length, names: free };
}

const selectionKeys = (cards, groups) => [...cards, ...groups.flatMap((g) => g.items)].filter(canGo).map((x) => x.key);

export function leadersView(args) {
  const c = boardContext(args);
  const { waiting: asking, otherWaiting } = windowsView(questionsAskedOnBoard(c));
  const { groups: byLeader, heldByChild } = collectGroups(c);
  const groups = [...byLeader].map(([leader, roots]) => groupView(c, leader, roots, heldByChild))
    .sort(stoppedThenMostRecentlyActive).map(withoutGroupSortKeys);
  const waiting = [...asking, ...panelessBlockedCards(c, groups)];
  const cards = waiting.map((card, i) => ({ key: "card:" + i, ...card }));
  return { waiting: cards, groups, idle: idleRow(c, waiting), otherWaiting, keys: selectionKeys(cards, groups) };
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
export const pendingView = (board) => openTasks(board)
  .filter((t) => t.pending).sort((x, y) => x.pending.at - y.pending.at || issueNumber(x.id) - issueNumber(y.id))
  .map((t) => ({ id: t.id, title: t.title, url: t.url ?? null }));

const issueTerminalsByName = (live) => new Map(live.flatMap((k) => {
  const named = issueNamedBy(k.name);
  return named ? [["#" + named[1], k.address]] : [];
}));

const matchIssues = (board, terminals) => {
  const live = terminals.filter(isLive), alive = new Set(live.map((k) => k.address));
  const byName = issueTerminalsByName(live);
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
  return { id: t.id, title: t.title, state, at: issueSince(t, state),
    gone: false, who: "worker", note: t.progress?.body ?? null, spec: null, decisions: t.decision ? [t.decision] : [], url: t.url ?? null,
    active: t.active_at, closed: state === "done" };
};

const AGENT_CENTER_SESSION_PREFIX = /^[a-z]+:(?=[0-9a-f]{8})/;
const sessionKey = (s) => s?.replace(AGENT_CENTER_SESSION_PREFIX, "") ?? null;

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

export function itemLabel({ state, at }, now, lang) {
  const w = WINDOW_WORDS[lang], label = w[ITEM_STATE[state]];
  if (at == null) return label;
  if (state !== "done") return label + " " + span(now - at, lang, true);
  return label + " " + [dayOf(at, now, w), clockTime(at)].filter(Boolean).join(" ");
}

const ITEM_STATE = { done: "done", current: "working", pushing: "pushing", stopped: "stopped", todo: "todo", waiting: "waiting" };
const pad = (n) => String(n).padStart(2, "0");
const calendarMonth = (d) => d.getMonth() + 1;

export const decisionDate = (at) => {
  const d = new Date(at * MS_PER_SECOND);
  return pad(calendarMonth(d)) + "-" + pad(d.getDate());
};

export const WINDOW_WORDS = {
  zh: { waiting: "等你", pushing: "在推", closed: (n) => `已关 ${n} 个`, stopped: "停了", done: "完成", working: "在干", idle: "空闲", todo: "还没动", yesterday: "昨天", confirm: "在等你确认",
    windows: (n) => `${n} 个窗口`, elsewhere: (n) => (n ? `其他项目 ${n} 个等你` : "其他项目没有等你的"),
    headline: (n) => `${n} 个窗口在等你`, waited: (d) => `等了 ${d}`, go: "去窗口 →", issue: "去 GitHub 看 →",
    counts: (own, sent) => `自己 ${own} · 派出 ${sent}`, decided: "定", who: { self: "自己", worker: "worker" },
    gone: "窗口已关，任务还拿着没交还",
    withState: (name, state) => `${name}（${state}）`, idleRow: (n, names) => `没认领 ${n} · ${names.join("、")}`,
    none: "这个 space 没有 agent 窗口", loading: "读取中…", error: "读不到看板", language: "语言",
    pending: (n) => `待决 ${n}`, windowsFold: (n) => `窗口分组 ${n}` },
  en: { waiting: "Waiting", pushing: "Moving", closed: (n) => `${n} closed`, stopped: "Stopped", done: "Done", working: "Working", idle: "Idle", todo: "Not started", yesterday: "yesterday", confirm: "Waiting for you to confirm",
    windows: (n) => `${n} window${n === 1 ? "" : "s"}`, elsewhere: (n) => (n ? `${n} waiting elsewhere` : "nothing waiting elsewhere"),
    headline: (n) => `${n} window${n === 1 ? "" : "s"} waiting on you`, waited: (d) => `waiting ${d}`, go: "Go to window →", issue: "Open on GitHub →",
    counts: (own, sent) => `own ${own} · sent ${sent}`, decided: "decided", who: { self: "self", worker: "worker" },
    gone: "Window closed, task still held",
    withState: (name, state) => `${name} (${state.toLowerCase()})`, idleRow: (n, names) => `No task ${n} · ${names.join(", ")}`,
    none: "No agent windows in this space", loading: "Loading…", error: "Can't read the board", language: "Language",
    pending: (n) => `Pending ${n}`, windowsFold: (n) => `Window groups ${n}` },
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

const OKR_KINDS_HARDEST_FIRST = ["five", "stuck", "wait", "accept"];
const KINDS_WITH_READINGS = ["five", "stuck"];
const OKR_STATES = ["met", "missed", "stale", "untested"];
const OPS = { ">=": "≥", "<=": "≤", ">": ">", "<": "<", "==": "=" };
const TENTHS = 10;
const oneDecimal = (v) => String(Math.round(v * TENTHS) / TENTHS);

const TARGET = /^\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
const parseTarget = (target, unit = "") => {
  const m = TARGET.exec(target ?? "");
  return m ? { op: m[1], goal: Number(m[2]), text: OPS[m[1]] + " " + m[2] + unit } : null;
};

const SPARK_MIDDLE = 50;
const SPARK_TOP_MARGIN = 10;
const SPARK_DRAWN_HEIGHT = 80;
const SPARK_LEFT_MARGIN = 4;
const SPARK_DRAWN_WIDTH = 92;

export function okrSpark(history, goal) {
  const vs = (history ?? []).map((h) => h.value);
  if (!vs.length) return null;
  const all = goal == null ? vs : [...vs, goal], lo = Math.min(...all), hi = Math.max(...all);
  const y = (v) => (hi === lo ? SPARK_MIDDLE : SPARK_TOP_MARGIN + ((hi - v) / (hi - lo)) * SPARK_DRAWN_HEIGHT);
  const x = (i) => (vs.length === 1 ? SPARK_MIDDLE : SPARK_LEFT_MARGIN + (i / (vs.length - 1)) * SPARK_DRAWN_WIDTH);
  return { points: vs.map((v, i) => [x(i), y(v)]), goal: goal == null ? null : y(goal), labels: vs.map(oneDecimal) };
}

const PERCENT_FULL = 100;
const BAR_HEADROOM = 1.25;
const NONZERO_SCALE = 1;
const barScale = (k, t) => (k.unit === "%" ? PERCENT_FULL
  : Math.max(Math.abs(k.value ?? 0), Math.abs(t?.goal ?? 0)) * BAR_HEADROOM || NONZERO_SCALE);
const isMeasured = (k) => k.value != null && k.status !== "untested";
const hasMismatch = (k) => Array.isArray(k.mismatch) && k.mismatch.length > 0;

const krRow = (k, w) => {
  const t = parseTarget(k.target, k.unit ?? ""), measured = isMeasured(k), scale = barScale(k, t);
  const onBar = (v) => Math.min(PERCENT_FULL, Math.max(0, (v / scale) * PERCENT_FULL));
  return { name: k.name, status: OKR_STATES.includes(k.status) ? k.status : "untested",
    value: measured ? oneDecimal(k.value) + (k.unit ?? "") : w.status.untested, target: t?.text ?? k.target ?? "",
    goal: t?.goal ?? null, fill: measured ? onBar(k.value) : null, tick: t ? onBar(t.goal) : null,
    as_of: k.as_of ?? null, source: k.source ?? null, trend: w.trend[k.trend] ?? w.trend.null,
    missed_rounds: k.missed_rounds ?? 0, wait: k.wait ?? null, history: k.history ?? [],
    mismatch: hasMismatch(k) ? w.mismatch(k.mismatch.map((m) => m.ticket)) : null };
};

const DIRS = ["↑", "↓", "="];
const declaredAny = (n) => n && DIRS.some((d) => n[d] > 0);
const impactLine = (n) => (declaredAny(n) ? DIRS.map((d) => d + (n[d] ?? 0)).join(" ") : null);

function objectiveView(o, w) {
  const krs = (o.krs ?? []).map((k) => krRow(k, w));
  const counts = Object.fromEntries(OKR_STATES.map((s) => [s, krs.filter((k) => k.status === s).length]));
  return { name: o.name, met: o.met ?? counts.met, total: o.total ?? krs.length, counts, impacts: impactLine(o.impacts),
    segments: OKR_STATES.flatMap((s) => Array(counts[s]).fill(s)), krs, attention: false };
}

const attentionRank = (objectives) => (a) => {
  const oi = objectives.findIndex((o) => o.name === a.objective), o = objectives[oi];
  return [OKR_KINDS_HARDEST_FIRST.indexOf(a.kind), oi, o ? o.krs.findIndex((k) => k.name === a.kr) : -1];
};
const byRank = ([x], [y]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

const onePerKr = () => {
  const seen = new Set();
  return ([, a]) => {
    const kr = a.objective + "\0" + (a.kr ?? "");
    return !seen.has(kr) && seen.add(kr);
  };
};

const isSameDecision = (a) => (group) => group[0].kind === "wait" && group[0].objective === a.objective && group[0].text === a.text;
const sameWaitsAsOneDecision = (out, [, a]) => {
  const same = a.kind === "wait" && out.find(isSameDecision(a));
  same ? same.push(a) : out.push([a]);
  return out;
};

function attentionCard(group, i, objectives, w) {
  const a = group[0], o = objectives.find((x) => x.name === a.objective), kr = o?.krs.find((k) => k.name === a.kr);
  if (o) o.attention = true;
  const key = "okr:" + i, base = { key, kind: a.kind, label: w.kind[a.kind], text: a.text ?? "" };
  if (group.length > 1) return { ...base, title: w.waits(a.objective, group.length), objective: null, spark: null, target: null,
    krs: group.map((x) => x.kr) };
  const spark = KINDS_WITH_READINGS.includes(a.kind) && kr ? okrSpark(kr.history, kr.goal) : null;
  return { ...base, title: a.kr || a.objective, objective: a.kr ? a.objective : null, spark, target: kr ? w.target + " " + kr.target : null };
}

export const isoMonthDay = (iso) => iso.slice(5, 10);
const isoHourMinute = (iso) => iso.slice(11, 16);
const isOkrReading = (okr) => okr && Array.isArray(okr.objectives) && okr.objectives.length > 0;

export function okrView(okr, lang) {
  if (!isOkrReading(okr)) return null;
  const w = OKR_WORDS[lang] ?? OKR_WORDS.en;
  const objectives = okr.objectives.map((o) => objectiveView(o, w));
  const rank = attentionRank(objectives);
  const attention = (okr.attention ?? []).filter((a) => OKR_KINDS_HARDEST_FIRST.includes(a.kind))
    .map((a) => [rank(a), a]).sort(byRank)
    .filter(onePerKr())
    .reduce(sameWaitsAsOneDecision, [])
    .map((group, i) => attentionCard(group, i, objectives, w));
  const at = okr.last_measured_at;
  return { met: okr.met, total: okr.total, measured: at ? isoMonthDay(at) + " " + isoHourMinute(at) : null, attention, objectives };
}

export const OKR_WORDS = {
  zh: { headline: (n) => `${n} 件要你盯`, summary: (met, total, at) => `OKR ${met}/${total} 达标${at ? ` · ${at} 量` : ""}`,
    kind: { five: "5 轮未达标", stuck: "两轮没变好", wait: "等你做", accept: "等你验收" },
    waits: (o, n) => `${o}：${n} 条 KR 等你批`, list: "、",
    status: { met: "达标", missed: "未达标", stale: "过期", untested: "未测" },
    trend: { closer: "在变好", away: "在变差", flat: "没动", null: "首次读数" },
    target: "目标", value: "现值", asOf: "截至", source: "来源", trendLabel: "走向", rounds: (n) => `连续 ${n} 轮未达标`, wait: "要你做",
    mismatch: (ts) => `预期不符 ${ts.join(" ")}` },
  en: { headline: (n) => `${n} thing${n === 1 ? "" : "s"} for you`, summary: (met, total, at) => `OKR ${met}/${total} met${at ? ` · measured ${at}` : ""}`,
    kind: { five: "Missed 5 rounds", stuck: "No better in 2 rounds", wait: "Needs you", accept: "Ready to accept" },
    waits: (o, n) => `${o}: ${n} KRs waiting on you`, list: ", ",
    status: { met: "Met", missed: "Missed", stale: "Stale", untested: "Untested" },
    trend: { closer: "Getting closer", away: "Moving away", flat: "Flat", null: "First reading" },
    target: "Target", value: "Value", asOf: "As of", source: "Source", trendLabel: "Trend", rounds: (n) => `missed ${n} rounds in a row`, wait: "Needs you to",
    mismatch: (ts) => `Not as declared ${ts.join(" ")}` },
};
