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
const PROGRESS_FOLDER = "/progress";
const LIVE_FILE = /^\d+\.json$/;
const isProgressWrite = (path, db) => path.startsWith(folderOf(db) + PROGRESS_FOLDER + "/") && LIVE_FILE.test(path.slice(path.lastIndexOf("/") + 1));
export const boardChanged = (paths, db) => paths.some((p) => isBoardFileOrItsLog(p, db) || isWatchedFolderItself(p, db) || isProgressWrite(p, db));

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
    focus: agent.address, ...(task?.url && { url: task.url }), task: task?.id ?? null, seq: agent.seq, since };
}

function strayCardOf(task, agents, terminals, nameOf, now, lang) {
  const away = agents.find((a) => a.address === task.terminal) ?? terminals.find((k) => isLive(k) && k.address === task.terminal);
  return { name: away ? nameOf(away) : task.id, question: task.waiting, doing: task.title, state: "waiting",
    label: WINDOW_WORDS[lang].waiting, duration: span(now - task.active_at, lang, true), focus: away?.address ?? null,
    url: task.url ?? null, task: task.id, seq: NO_HERDR_SEQ, since: task.active_at };
}

const UNTIMED_WAITS_LAST = Infinity;
const longestWaitingFirst = (x, y) => (x.since ?? UNTIMED_WAITS_LAST) - (y.since ?? UNTIMED_WAITS_LAST) || newestHerdrChangeFirst(x, y);
const withoutSortKeys = ({ seq, since, ...w }) => w;
const withoutTask = ({ task, ...w }) => w;
const ROW_ORDER = ["stopped", "done", "working"];

const waitingInOtherProjects = (projects, project) =>
  (projects?.projects ?? []).reduce((n, p) => n + (p.name === project ? 0 : p.waiting ?? 0), 0);

function windowsAndWaits({ agents, space, board, now, lang, terminals = [] }) {
  const nameOf = namer(terminals);
  const open = openTasks(board).sort(newestActivityFirst);
  const here = agents.filter((a) => a.space === space);
  const windows = here.map((a) => windowOf(a, open, nameOf, now, lang));
  const inNoWindowHere = (t) => !here.some((a) => a.address === t.terminal);
  const strays = open.filter((t) => isAsking(t) && inNoWindowHere(t)).map((t) => strayCardOf(t, agents, terminals, nameOf, now, lang));
  return { windows, waiting: [...windows, ...strays].filter((w) => w.state === "waiting").sort(longestWaitingFirst).map(withoutSortKeys) };
}

export function windowsView(args) {
  const { windows, waiting } = windowsAndWaits(args);
  const rows = ROW_ORDER.flatMap((s) => windows.filter((w) => w.state === s).sort(newestHerdrChangeFirst)).map(withoutSortKeys).map(withoutTask);
  const idle = windows.filter((w) => w.state === "idle").map((w) => w.name);
  return { waiting: waiting.map(withoutTask), rows, idle: { count: idle.length, names: idle }, otherWaiting: waitingInOtherProjects(args.projects, args.project) };
}

const isBareTabIndex = (tabName) => /^\d+$/.test(tabName);
const namer = (terminals) => {
  const names = new Map(terminals.map((k) => [k.address, k.name]));
  return (a) => names.get(a.address) || (isBareTabIndex(a.tab_name) ? "" : a.tab_name) || a.title;
};

const withoutQuestionsThatAreDecisions = (board, github) => ({ ...board,
  columns: board.columns.map((c) => ({ ...c, tasks: (c.tasks ?? []).map((t) => (github || t.pending ? { ...t, waiting: null } : t)) })) });

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

const questionsAskedOnBoard = (c) => (c.board ? { ...c, board: withoutQuestionsThatAreDecisions(c.board, c.github) } : c);

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
    doing: held ? doingOf(lead, c.byId, root.title, window?.status, c.now) : null,
    gone: state === "stopped" && !window,
    note: held ? lead.progress?.body ?? null : null, focus: window ? lead.terminal : null,
    spec: tickets.length ? { done: states.filter((s) => s === "done").length, total: tickets.length } : null,
    url: root.url ?? null, active: Math.max(...[root, ...tickets].map((t) => t.active_at ?? 0)) };
}

const STALE_AFTER = 30 * MINUTE;
const STEPS_SHOWN_AHEAD = 2;
const RULING_CHARS = 12;
const STUCK_REASON_CHARS = 40;
const isFinishedStep = (s) => s.status === "completed";
const clip = (text, n) => {
  const chars = [...oneLine(text)];
  return chars.length <= n ? chars.join("") : chars.slice(0, n).join("") + "…";
};

export function stepChain(steps) {
  const done = steps.filter(isFinishedStep).length;
  const at = steps.findIndex((s) => s.status === "in_progress");
  const now = at >= 0 ? at : steps.findIndex((s) => !isFinishedStep(s));
  if (now < 0) return "✓" + done + " 步，全部做完";
  const ahead = steps.slice(now + 1).filter((s) => !isFinishedStep(s)).slice(0, STEPS_SHOWN_AHEAD).map((s) => s.subject);
  return [...(done ? ["✓" + done + " 步"] : []), "[" + steps[now].subject + "]", ...ahead].join(" → ");
}

const QUOTED = /「([^」]+)」/;
const WHO_AND_WHEN_ALREADY_SHOWN = /^决策者\s*\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*[：:，,]?\s*/;
const rulingWords = (verdict) => clip((QUOTED.exec(verdict) ?? [null, verdict.replace(WHO_AND_WHEN_ALREADY_SHOWN, "")])[1], RULING_CHARS);
const rulingOf = (t, byId) => t.ruling ?? byId.get(t.parent)?.ruling ?? null;
const rulingLine = (r) => (r ? "决策者 " + decisionDate(r.at) + " " + clockTime(r.at) + " 说「" + rulingWords(r.verdict) + "」" : "编排者代定");

function stuckOn(t, status) {
  if (isAsking(t)) return "在等你：" + clip(t.waiting, STUCK_REASON_CHARS);
  if (herdrSaysBlocked(status)) return "在等你批权限";
  return null;
}

const MILESTONES = ["started", "edited", "committed", "pr", "review", "reported"];
const MILESTONE_WORDS = { started: "开工", edited: "首次改文件", committed: "首次提交", pr: "开 PR", review: "review", reported: "回报" };
export const milestoneChain = (reached) => {
  const at = Math.max(0, MILESTONES.indexOf(reached));
  return stepChain(MILESTONES.map((m, i) => ({ subject: MILESTONE_WORDS[m], status: i < at ? "completed" : i === at ? "in_progress" : "pending" })));
};

export function doingOf(t, byId, title, status, now) {
  const stuck = stuckOn(t, status);
  const head = stuck ? "【卡住】" + title + " —— " + stuck : "【在做】" + title + " —— " + rulingLine(rulingOf(t, byId));
  const moved = t.live?.at ?? t.active_at ?? null;
  const quiet = moved == null ? 0 : now - moved;
  const stale = !stuck && status !== "working" && quiet > STALE_AFTER;
  const when = moved == null ? null : stale ? span(quiet, "zh", true) + "没动" : quiet < MINUTE ? "刚刚还在动" : span(quiet, "zh", true) + "前还在动";
  return { head, chain: [milestoneChain(t.live?.milestone ?? "started"), when].filter(Boolean).join(" · "), stale };
}

const localMidnightSeconds = (now) => localMidnight(now) / MS_PER_SECOND;
export const closedToday = (board, now) => allTasks(board).filter((t) => isDone(t) && (t.done_at ?? 0) >= localMidnightSeconds(now)).length;
export const flowLine = ({ closed, running, waiting }) => "今天关了 " + closed + " · 在跑 " + running + " · 等你 " + waiting;

const ISSUE_NAME = /^gh-(\d+)/;
const issueNamedBy = (name) => ISSUE_NAME.exec(name ?? "");
const childName = (k) => k.name || k.program?.name || k.address;

const isUnclaimedIssue = (t) => !isDone(t) && !isHeld(t) && !t.terminal && !isAsking(t);
function issueTaskItem(c, t) {
  if (isUnclaimedIssue(t)) return { ...issueItem(t, null, c.now), state: "todo", at: null };
  const window = t.terminal ? c.windowAt(t.terminal) : null;
  return { ...issueItem(t, window?.status, c.now), focus: window ? t.terminal : null,
    doing: isHeld(t) && !isDone(t) ? doingOf(t, c.byId, t.title, window?.status, c.now) : null };
}

const taskItems = (c) => (c.github ? c.tasks.map((t) => issueTaskItem(c, t))
  : c.tasks.filter((t) => rootOf(c, t) === t).map((root) => itemOf(c, root)));

export const TASK_GROUPS = ["stopped", "working", "todo", "done"];
const TASK_GROUP_OF_STATE = { waiting: "stopped", stopped: "stopped", current: "working", pushing: "working", todo: "todo", done: "done" };
const latestDoneFirst = (x, y) => (y.at ?? 0) - (x.at ?? 0);
const mostRecentlyActiveFirst = (x, y) => y.active - x.active;
const ORDER_IN_GROUP = { done: latestDoneFirst };

const listedAs = (c, id) => (c.github ? id : rootOf(c, c.byId.get(id)).id);

function taskGroups(c, items, cards) {
  const onACard = new Set(cards.filter((card) => card.task != null && c.byId.has(card.task)).map((card) => listedAs(c, card.task)));
  const listed = items.filter((x) => !onACard.has(x.id));
  return TASK_GROUPS.map((group) => ({ group, items: listed.filter((x) => TASK_GROUP_OF_STATE[x.state] === group)
    .sort(ORDER_IN_GROUP[group] ?? mostRecentlyActiveFirst)
    .map(({ active, ...x }) => ({ key: "task:" + x.id, ...x, where: x.focus == null ? null : c.nameOf(c.windowAt(x.focus)) })) }))
    .filter((g) => g.items.length);
}

function panelessBlockedCards(c, items) {
  if (!c.github) return [];
  const words = WINDOW_WORDS[c.lang];
  const isPanelessBlockedChild = (k) => c.leaderOf.has(k.address) && !c.agentAt(k.address) && herdrSaysBlocked(k.status);
  return c.live.filter(isPanelessBlockedChild).flatMap((k) => {
    const x = items.find((i) => i.focus === k.address);
    return x ? [{ name: childName(k), question: words.confirm, doing: x.title, state: "waiting", label: words.waiting, duration: null,
      focus: x.focus, ...(x.url && { url: x.url }), task: x.id }] : [];
  });
}

export function panelView(args) {
  const c = boardContext(args);
  const { waiting: asking } = windowsAndWaits(questionsAskedOnBoard(c));
  const items = taskItems(c);
  const cards = [...asking, ...panelessBlockedCards(c, items)];
  const tasks = taskGroups(c, items, cards);
  const flow = c.board && flowLine({ closed: closedToday(c.board, c.now),
    running: tasks.find((g) => g.group === "working")?.items.length ?? 0,
    waiting: cards.length + decisionCardsView(c.board).cards.length });
  return { waiting: cards.map((card, i) => ({ key: "card:" + i, ...withoutTask(card) })), tasks,
    flow: flow || null, otherWaiting: waitingInOtherProjects(c.projects, c.project) };
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

export const GROUP_OPEN_BY_DEFAULT = new Set(["stopped", "working"]);
export const ROWS_SHOWN_PER_GROUP = 3;
const GROUP_KEY_PREFIX = "group:";
const MORE_KEY_PREFIX = "more:";
export const moreKey = (group) => MORE_KEY_PREFIX + group;
export const groupOfMoreKey = (key) => (key?.startsWith(MORE_KEY_PREFIX) ? key.slice(MORE_KEY_PREFIX.length) : null);
export const groupOfKey = (key) => (key?.startsWith(GROUP_KEY_PREFIX) ? key.slice(GROUP_KEY_PREFIX.length) : null);
export const foldKey = (project, group) => (project ?? "") + ":" + group;
export const isGroupOpen = (folds, project, group) => folds?.[foldKey(project, group)] ?? GROUP_OPEN_BY_DEFAULT.has(group);
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

export function taskSections(groups, { folds, project, shownAll }) {
  return groups.map(({ group, items }) => {
    const allShown = Boolean(shownAll?.[foldKey(project, group)]);
    const capped = items.length > ROWS_SHOWN_PER_GROUP;
    const shown = capped && !allShown ? items.slice(0, ROWS_SHOWN_PER_GROUP) : items;
    return { key: GROUP_KEY_PREFIX + group, group, count: items.length, open: isGroupOpen(folds, project, group),
      items: shown,
      more: capped ? { hidden: allShown ? 0 : items.length - ROWS_SHOWN_PER_GROUP } : null };
  });
}

const keysUnder = (s) => (s.open ? [...s.items.map((x) => x.key), ...(s.more ? [moreKey(s.group)] : [])] : []);
export const panelKeys = (decisions, krs, sections) => [...decisions, ...krs, ...sections.flatMap((s) => [s.key, ...keysUnder(s)])];

const pendingTasks = (board) => openTasks(board)
  .filter((t) => t.pending).sort((x, y) => x.pending.at - y.pending.at || issueNumber(x.id) - issueNumber(y.id));

export const repoRootOf = (gitCommonDir) => {
  const dir = String(gitCommonDir ?? "").trim();
  return dir.endsWith("/.git") ? folderOf(dir) : null;
};
const insideRepo = (cwd, repo) => cwd === repo || String(cwd ?? "").startsWith(repo + "/");
const isOrchestratorOf = (repo) => (k) => isLive(k) && k.labels?.role === "orchestrator" && Boolean(repo) && insideRepo(k.cwd, repo);
export const orchestratorOf = (terminals, repo) => (terminals ?? []).find(isOrchestratorOf(repo)) ?? null;

const NO_KR_WORDS = new Set(["", "无", "none"]);
const saysSomething = (kr) => kr != null && !NO_KR_WORDS.has(String(kr).trim().toLowerCase());
const cardKindOf = (p) => (!p.card ? "incomplete" : p.ruled_after ? "maybe" : p.talk ? "talk" : "pick");
export const returnMark = (t) => t.id + "@" + t.pending.at;
const shownName = (k) => k.name || k.address;
const liveWindowNamed = (terminals, name) => name ? terminals.find((k) => isLive(k) && (k.address === name || k.name === name)) : null;
const stamped = (n) => n ? decisionDate(n.at) + " " + clockTime(n.at) + " " + oneLine(n.body) : null;

function windowToTalkIn(p, terminals, orchestrator) {
  const named = liveWindowNamed(terminals, p.talk.window);
  const there = named ?? orchestrator;
  return there ? { focus: there.address, name: named ? p.talk.window : shownName(there) } : { focus: null, name: p.talk.window };
}

function decisionCardOf(t, kind, terminals, orchestrator) {
  const p = t.pending;
  return { key: "pending:" + t.id, id: t.id, mark: returnMark(t), title: oneLine(p.card.decision), kind, url: t.url ?? null,
    sub: [t.id, saysSomething(p.card.kr) && p.card.kr, decisionDate(p.at)].filter(Boolean).join(" · "),
    decision: p.card.decision, kr: p.card.kr, context: p.card.context,
    progress: stamped(p.progress?.at(-1)), options: p.card.options, rec: p.card.rec,
    window: kind === "talk" ? windowToTalkIn(p, terminals, orchestrator) : null };
}

export function decisionCardsView(board, { terminals = [], repo = null, returned = [] } = {}) {
  const orchestrator = orchestratorOf(terminals, repo);
  const pending = pendingTasks(board).map((t) => ({ t, kind: cardKindOf(t.pending) }));
  const incomplete = pending.filter((x) => x.kind === "incomplete").map(({ t }) => ({ id: t.id, mark: returnMark(t) }));
  return { orchestrator: orchestrator?.address ?? null,
    cards: pending.filter((x) => x.kind !== "incomplete").map(({ t, kind }) => decisionCardOf(t, kind, terminals, orchestrator)),
    incomplete: { ids: incomplete.map((x) => x.id), marks: incomplete.map((x) => x.mark),
      unreturned: incomplete.filter((x) => !returned.includes(x.mark)) } };
}

export const TO_ORCHESTRATOR = {
  pick: (id, option) => `[决策者经面板] ${id} 选 ${option}`,
  unclear: (id) => `[决策者经面板] ${id} 背景不够，请补写后重发待决`,
  decided: (id) => `[决策者经面板] ${id} 已定，请核实后记已决（决策记录）`,
  incomplete: (ids) => `[决策者经面板] 待决未就绪（不满足就绪标准），请按待决策项格式重写：${ids.join(" ")}`,
  capture: (text) => `[决策者经面板] 收件箱：${text}。请转成任务或命令，回我结果`,
};

export const marksStillToKeep = (returned, incomplete, justReturned) =>
  incomplete.marks.filter((m) => returned.includes(m) || justReturned.includes(m));

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
  return { id: t.id, title: t.title, state, at: issueSince(t, state), gone: false,
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
  zh: { waiting: "等你", pushing: "进行中", stopped: "停滞", done: "已完成", working: "在干", idle: "空闲", todo: "待办", yesterday: "昨天", confirm: "在等你确认",
    windows: (n) => `${n} 个窗口`, elsewhere: (n) => (n ? `其他项目 ${n} 件等你` : "其他项目没有等你的"),
    gone: "窗口已关，任务还拿着没交还", none: "这个 space 没有 agent 窗口", loading: "读取中…", error: "读不到看板", language: "语言",
    nothingToDecide: "没有等你决定的待决", tabs: { decide: "待决", okr: "OKR", tasks: "任务", capture: "收件箱" },
    capture: { placeholder: "记一条想法，回车存", hand: "交给编排者", remove: "删除", noOrchestrator: "没有编排者", handed: (at) => `已交 ${at}`, handedGroup: (n) => `已交 ${n}`, empty: "还没有记下的想法" }, groups: { stopped: "停滞", working: "进行中", todo: "待办", done: "已完成" },
    more: (n) => `再显示 ${n} 条`, less: "收起", go: "去窗口", issue: "去 GitHub",
    facts: { id: "编号", question: "问题", note: "进展", window: "窗口", since: "多久", spec: "已合" },
    cards: { chip: { pick: "选一项", maybe: "可能已定", talk: "去窗口聊" }, decision: "决策事项", kr: "关联 KR", context: "背景", progress: "最新进展",
      noProgress: "还没有进展", rec: "建议",
      settle: "就这么定", unclear: "不够，再说清楚", decided: "对，已经定了", notYet: "还没定", fullText: "GitHub 全文",
      goTalk: (name) => `去 ${name} 窗口`, noOrchestrator: "没有活着的编排者窗口，暂时交不出去", sending: "正在交给编排者…",
      failed: (e) => `没交到编排者：${e}`, picked: (id, option) => `已交给编排者：${id} 选 ${option}。它会在 issue 上记已决（决策记录）。`,
      sentBack: "已退回编排者补写背景。", closing: (id) => `已请编排者在 ${id} 记已决（决策记录）并关掉这件待决。`,
      incomplete: (ids, state) => `未就绪 ${ids.length} 件（${ids.join(" ")}），${{ returned: "已退回编排者重写", returning: "正在退回编排者", stuck: "没有编排者窗口，还没退回" }[state]}` } },
  en: { waiting: "Waiting", pushing: "WIP", stopped: "Stale", done: "Done", working: "Working", idle: "Idle", todo: "Backlog", yesterday: "yesterday", confirm: "Waiting for you to confirm",
    windows: (n) => `${n} window${n === 1 ? "" : "s"}`, elsewhere: (n) => (n ? `${n} waiting elsewhere` : "nothing waiting elsewhere"),
    gone: "Window closed, task still held", none: "No agent windows in this space", loading: "Loading…", error: "Can't read the board", language: "Language",
    nothingToDecide: "No Decision Requests", tabs: { decide: "Decide", okr: "OKR", tasks: "Tasks", capture: "Inbox" },
    capture: { placeholder: "Jot an idea, Enter to keep it", hand: "Hand to orchestrator", remove: "Delete", noOrchestrator: "No orchestrator", handed: (at) => `Handed ${at}`,
      handedGroup: (n) => `Handed ${n}`, empty: "Nothing jotted down yet" }, groups: { stopped: "Stale", working: "WIP", todo: "Backlog", done: "Done" },
    more: (n) => `Show ${n} more`, less: "Show less", go: "Go to window", issue: "Open on GitHub",
    facts: { id: "ID", question: "Question", note: "Progress", window: "Window", since: "For", spec: "Merged" },
    cards: { chip: { pick: "Pick one", maybe: "Maybe decided", talk: "Talk in a window" }, decision: "BLUF", kr: "KR", context: "Context",
      progress: "Status", noProgress: "No progress yet",
      rec: "Recommendation", settle: "Decide", unclear: "Not enough, explain more", decided: "Yes, already decided", notYet: "Not yet",
      fullText: "Full text on GitHub", goTalk: (name) => `Go to ${name}`, noOrchestrator: "No live orchestrator window to hand this to",
      sending: "Handing to the orchestrator…", failed: (e) => `Not handed over: ${e}`,
      picked: (id, option) => `Handed to the orchestrator: ${id} picks ${option}. It records the Decision Record on the issue.`,
      sentBack: "Sent back to the orchestrator to fill in the Context.", closing: (id) => `Asked the orchestrator to record ${id}'s Decision Record and close the DR.`,
      incomplete: (ids, state) => `${ids.length} DR${ids.length === 1 ? "" : "s"} not ready (${ids.join(" ")}), ${{ returned: "sent back to the orchestrator", returning: "sending back to the orchestrator", stuck: "no orchestrator window to send them back to" }[state]}` } },
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

const KEYS = { down: "down", up: "up", enter: "open", escape: "back", left: "left", right: "right", 1: "1", 2: "2", 3: "3", 4: "4" };
export const keyCommand = (e) => KEYS[e.keystroke] ?? null;

const OKR_STATES = ["met", "missed", "stale", "untested"];
const KR_STATUS_WORST_FIRST = ["missed", "stale", "untested", "met"];
const OPS = { ">=": "≥", "<=": "≤", ">": ">", "<": "<", "==": "=" };
const LOWER_IS_BETTER = new Set(["<=", "<"]);
const UNITS_COUNTED_IN_POINTS = new Set(["%", "百分点", "个百分点"]);
const TENTHS = 10;
const toTenths = (v) => Math.round(v * TENTHS) / TENTHS;
const oneDecimal = (v) => String(toTenths(v));

export const gapOf = (op, goal, value) =>
  toTenths(op === "==" ? -Math.abs(value - goal) : LOWER_IS_BETTER.has(op) ? goal - value : value - goal);

export const varianceText = (gap, unit, w) =>
  [(gap < 0 ? "-" : "+") + Math.abs(gap).toFixed(1), UNITS_COUNTED_IN_POINTS.has(unit) ? w.point : unit].filter(Boolean).join(" ");

const hasStructuredTarget = (k) => OPS[k.target_op] != null && Number.isFinite(k.target_value);
const targetText = (k, unit) => (hasStructuredTarget(k) ? OPS[k.target_op] + " " + oneDecimal(k.target_value) + unit : k.target ?? "");

const isMeasured = (k) => k.value != null && k.status !== "untested";
const hasMismatch = (k) => Array.isArray(k.mismatch) && k.mismatch.length > 0;

const krRow = (k, w) => {
  const unit = k.unit ?? "", measured = isMeasured(k);
  return { name: k.name, status: OKR_STATES.includes(k.status) ? k.status : "untested",
    value: measured ? oneDecimal(k.value) + unit : w.status.untested, target: targetText(k, unit), measured,
    gap: measured && hasStructuredTarget(k) ? varianceText(gapOf(k.target_op, k.target_value, k.value), unit, w) : null,
    as_of: k.as_of ?? null, day: measured && k.as_of ? isoMonthDay(k.as_of) : null, source: k.source ?? null,
    trend: w.trend[k.trend] ?? w.trend.null, missed_rounds: k.missed_rounds ?? 0, wait: k.wait ?? null,
    mismatch: hasMismatch(k) ? w.mismatch(k.mismatch.map((m) => m.ticket)) : null };
};

const worstFirst = (x, y) => KR_STATUS_WORST_FIRST.indexOf(x.status) - KR_STATUS_WORST_FIRST.indexOf(y.status);
const isMet = (k) => k.status === "met";
const isUntested = (k) => k.status === "untested";
const isListed = (k) => !isMet(k) && !isUntested(k);

const OBJECTIVE_STANDING = ["missed", "unsure", "met"];
const standingOf = (krs) => (krs.some((k) => k.status === "missed") ? "missed" : krs.length && krs.every(isMet) ? "met" : "unsure");
const neediestObjectiveFirst = (x, y) => OBJECTIVE_STANDING.indexOf(x.standing) - OBJECTIVE_STANDING.indexOf(y.standing);
export const OBJECTIVE_FOLD_PREFIX = "okr:";
const UNTESTED_FOLD_PREFIX = "okr-untested:";

function objectiveView(o, w) {
  const krs = (o.krs ?? []).map((k) => krRow(k, w)).sort(worstFirst);
  return { name: o.name, met: o.met ?? krs.filter(isMet).length, total: o.total ?? krs.length,
    standing: standingOf(krs), fold: OBJECTIVE_FOLD_PREFIX + o.name, untestedFold: UNTESTED_FOLD_PREFIX + o.name,
    krs: krs.filter(isListed), untestedKrs: krs.filter(isUntested), metKrs: krs.filter(isMet) };
}

export const isoMonthDay = (iso) => iso.slice(5, 10);
const isoHourMinute = (iso) => iso.slice(11, 16);
const isOkrReading = (okr) => okr && Array.isArray(okr.objectives) && okr.objectives.length > 0;

export function okrView(okr, lang) {
  if (!isOkrReading(okr)) return null;
  const w = OKR_WORDS[lang] ?? OKR_WORDS.en;
  const at = okr.last_measured_at;
  return { met: okr.met, total: okr.total, measured: at ? isoMonthDay(at) + " " + isoHourMinute(at) : null,
    objectives: okr.objectives.map((o) => objectiveView(o, w)).sort(neediestObjectiveFirst) };
}

export const OKR_WORDS = {
  zh: { tally: (met, total, at) => `${met}/${total} 达标${at ? ` · ${at} 量` : ""}`,
    status: { met: "绿", missed: "红", stale: "黄", untested: "未测" },
    trend: { closer: "在变好", away: "在变差", flat: "没动", null: "首次读数" },
    target: "目标", value: "现值", asOf: "截至", source: "来源", trendLabel: "走向", rounds: (n) => `连续 ${n} 轮未达标`, wait: "要你做",
    mismatch: (ts) => `预期不符 ${ts.join(" ")}`, noObjective: "这个项目还没有 O",
    variance: "偏差", asOfShort: "截至", point: "点", metFolded: (n) => `${n} 条已达标`, untestedFolded: (n) => `${n} 条未测`, allMet: "全部达标" },
  en: { tally: (met, total, at) => `Green ${met}/${total}${at ? ` · measured ${at}` : ""}`,
    status: { met: "Green", missed: "Red", stale: "Amber", untested: "Untested" },
    trend: { closer: "Getting closer", away: "Moving away", flat: "Flat", null: "First reading" },
    target: "Target", value: "Value", asOf: "As of", source: "Source", trendLabel: "Trend", rounds: (n) => `Red ${n} rounds in a row`, wait: "Needs you to",
    mismatch: (ts) => `Not as declared ${ts.join(" ")}`, noObjective: "No Objective for this project yet",
    variance: "variance", asOfShort: "as of", point: "pt", metFolded: (n) => `${n} Green`, untestedFolded: (n) => `${n} untested`, allMet: "all Green" },
};

export const TABS = ["decide", "okr", "tasks", "capture"];
export const openingTab = (picked, pending) => (TABS.includes(picked) ? picked : pending > 0 ? "decide" : "okr");

const missedKrs = (okr) => okr.objectives.flatMap((o) => o.krs).filter((k) => k.status === "missed").length;
function okrBadge(okr) {
  if (!okr) return null;
  const missed = missedKrs(okr);
  if (missed) return { text: String(missed), tone: "missed" };
  return okr.objectives.every((o) => o.standing === "met") ? { text: "✓", tone: "met" } : null;
}
export const tabBadges = ({ pending, okr, openTasks, unhanded }) => ({
  decide: pending ? { text: String(pending), tone: "ask" } : null,
  okr: okrBadge(okr),
  tasks: openTasks ? { text: String(openTasks), tone: "plain" } : null,
  capture: unhanded ? { text: String(unhanded), tone: "plain" } : null });

export const CAPTURE_FOLD = "captureHanded";
export const captureStoreKey = (project) => "capture:" + (project ?? "");
const isCapture = (x) => x && typeof x.id === "string" && typeof x.text === "string" && Number.isFinite(x.at);
export const capturesFrom = (stored) => (Array.isArray(stored) ? stored.filter(isCapture) : []);
export const addCapture = (list, text, at) => {
  const kept = String(text ?? "").trim();
  return kept ? [...list, { id: at + "-" + list.length, text: kept, at }] : list;
};
export const removeCapture = (list, id) => list.filter((x) => x.id !== id);
export const markHanded = (list, id, at) => list.map((x) => (x.id === id ? { ...x, handedAt: at } : x));
const isHanded = (x) => Number.isFinite(x.handedAt);
export const captureView = (list) => ({
  open: list.filter((x) => !isHanded(x)).sort((a, b) => b.at - a.at),
  handed: list.filter(isHanded).sort((a, b) => b.handedAt - a.handedAt) });
export const unhandedCount = (list) => list.filter((x) => !isHanded(x)).length;
const twoDigits = (n) => String(n).padStart(2, "0");
export const localMonthDayTime = (ms) => {
  const d = new Date(ms);
  return twoDigits(d.getMonth() + 1) + "-" + twoDigits(d.getDate()) + " " + twoDigits(d.getHours()) + ":" + twoDigits(d.getMinutes());
};
