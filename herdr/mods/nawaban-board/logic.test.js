import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTasks, projectFor, resolveLang, filterGroups, ago, shortId, linkParts, eventMarkdown, detailEvents, isBlocked, latestOnly,
  listRows, moveSelection, keyCommand, escapeStep, boardChanged, groupCount, authorLabel, shownSelection } from "./logic.js";

const task = (id, open_blockers = 0) => ({ id, title: id, open_blockers });

test("groups run in progress, then open with blocked tasks last and marked, then done", () => {
  const board = { columns: [
    { key: "open", tasks: [task("B1", 1), task("A"), task("B2", 2), task("C")] },
    { key: "in_progress", tasks: [task("P")] },
    { key: "done", tasks: [task("D")] },
  ] };
  const groups = groupTasks(board);
  assert.deepEqual(groups.map((g) => g.key), ["in_progress", "open", "done"]);
  assert.deepEqual(groups[1].tasks.map((t) => [t.id, t.blocked]),
    [["A", false], ["C", false], ["B1", true], ["B2", true]]);
  assert.deepEqual(groups[0].tasks.map((t) => t.id), ["P"]);
  assert.deepEqual(groups[2].tasks.map((t) => t.id), ["D"]);
});

test("a folder's project is its repository's main checkout name, when the board has that project", () => {
  const projects = { projects: [{ name: "nawaban" }, { name: "roubao" }] };
  // `git rev-parse --path-format=absolute --git-common-dir`, run in a worktree or the checkout
  assert.equal(projectFor("/Users/v/nawaban/.git\n", projects), "nawaban");
  assert.equal(projectFor("/Users/v/elsewhere/.git\n", projects), null);
  assert.equal(projectFor("", projects), null); // not in a git repository
});

test("the saved language wins, else the system's first preferred language: Chinese or English", () => {
  const apple = (...langs) => `(\n${langs.map((l) => `    "${l}"`).join(",\n")}\n)\n`; // defaults read -g AppleLanguages
  assert.equal(resolveLang(null, apple("zh-Hans-JP")), "zh");
  assert.equal(resolveLang(null, apple("en-US", "zh-Hans")), "en");
  assert.equal(resolveLang(null, apple("ja-JP")), "en");
  assert.equal(resolveLang(null, "zh_CN.UTF-8"), "zh"); // $LANG, off macOS
  assert.equal(resolveLang(null, ""), "en");
  assert.equal(resolveLang("en", apple("zh-Hans")), "en");
  assert.equal(resolveLang("zh", "en_US.UTF-8"), "zh");
  assert.equal(resolveLang("fr", "zh_CN.UTF-8"), "zh"); // an unknown saved value is ignored
});

test("the filter box matches ID or title, and a status chip keeps one kind of task", () => {
  const groups = groupTasks({ columns: [
    { key: "in_progress", tasks: [{ id: "NAWA-1", title: "Panel view" }] },
    { key: "open", tasks: [{ id: "NAWA-2", title: "Detail page", open_blockers: 1 }, { id: "NAWA-3", title: "Install docs" }] },
    { key: "done", tasks: [{ id: "OTHER-4", title: "panel data" }] },
  ] });
  const ids = (gs) => gs.map((g) => [g.key, g.tasks.map((t) => t.id)]);
  assert.deepEqual(ids(filterGroups(groups, "PANEL", "all")), [["in_progress", ["NAWA-1"]], ["open", []], ["done", ["OTHER-4"]]]);
  assert.deepEqual(ids(filterGroups(groups, " nawa-3 ", "all")), [["in_progress", []], ["open", ["NAWA-3"]], ["done", []]]);
  assert.deepEqual(ids(filterGroups(groups, "", "open")), [["open", ["NAWA-3"]]]);
  assert.deepEqual(ids(filterGroups(groups, "", "blocked")), [["open", ["NAWA-2"]]]);
  assert.deepEqual(ids(filterGroups(groups, "", "in_progress")), [["in_progress", ["NAWA-1"]]]);
});

test("times read as how long ago, in the panel's language", () => {
  const now = 1_000_000;
  assert.equal(ago(now - 20, now, "zh"), "刚刚");
  assert.equal(ago(now - 180, now, "zh"), "3 分钟前");
  assert.equal(ago(now - 180, now, "en"), "3m ago");
  assert.equal(ago(now - 2 * 3600, now, "en"), "2h ago");
  assert.equal(ago(now - 5 * 86400, now, "zh"), "5 天前");
});

test("a long ID keeps its head and its distinguishing tail, cut in the middle", () => {
  assert.equal(shortId("NAWABAN-HERDR-PANEL-03", 18), "NAWABAN-…-PANEL-03");
  assert.equal(shortId("NAWABAN-HERDR-PANEL-02", 18), "NAWABAN-…-PANEL-02");
  assert.equal(shortId("INTSTD-RESEARCH-OFFBOARD-PROPAGATION-001", 18), "INTSTD-R…ATION-001");
  assert.equal(shortId("NAWABAN-HERDR-PANEL", 18), "NAWABAN-…RDR-PANEL");
  assert.equal(shortId("LEAN-03", 18), "LEAN-03");
  assert.equal(shortId("EXACTLY-EIGHTEEN18", 18), "EXACTLY-EIGHTEEN18");
});

test("a link event reads as its kind, its value and a note; only http(s) values open", () => {
  assert.deepEqual(linkParts("pr:https://github.com/a/b/pull/42"),
    { kind: "pr", value: "https://github.com/a/b/pull/42", note: null, url: "https://github.com/a/b/pull/42" });
  assert.deepEqual(linkParts("pr: https://example.test/pull/1 · merged"),
    { kind: "pr", value: "https://example.test/pull/1", note: "merged", url: "https://example.test/pull/1" });
  assert.deepEqual(linkParts("https://example.test/a"),
    { kind: null, value: "https://example.test/a", note: null, url: "https://example.test/a" });
  assert.deepEqual(linkParts("commit:c4944fff64424170585455a345e2978086dd8aa1"),
    { kind: "commit", value: "c4944fff64424170585455a345e2978086dd8aa1", note: null, url: null });
  assert.deepEqual(linkParts("adr:docs/adr/0003-board.md"),
    { kind: "adr", value: "docs/adr/0003-board.md", note: null, url: null });
});

test("an open task is blocked while any task it waits on is not done or cancelled", () => {
  const ref = (status) => ({ id: status, title: status, status });
  assert.equal(isBlocked({ status: "open", blocked_by: [ref("done"), ref("in_progress")] }), true);
  assert.equal(isBlocked({ status: "open", blocked_by: [ref("open")] }), true);
  assert.equal(isBlocked({ status: "open", blocked_by: [ref("done"), ref("cancelled")] }), false);
  assert.equal(isBlocked({ status: "in_progress", blocked_by: [ref("open")] }), false);
  assert.equal(isBlocked({ status: "open", blocked_by: [] }), false);
});

test("an event body keeps its line breaks as markdown, a decision's labels in bold", () => {
  assert.equal(eventMarkdown("Question: A\nVerdict: B\nRejected: C"), "**Question:** A  \n**Verdict:** B  \n**Rejected:** C");
  assert.equal(eventMarkdown("question: A\nsee Verdict: no"), "**question:** A  \nsee Verdict: no"); // migrated, lower case
});

test("the detail's event stream holds notes, decisions and links, newest first, without status changes", () => {
  const ev = (kind, at) => ({ kind, body: kind, author: "s", at });
  const events = [ev("status", 5), ev("note", 4), ev("link", 3), ev("decision", 2), ev("status", 1)];
  assert.deepEqual(detailEvents(events).map((e) => e.kind), ["note", "link", "decision"]);
  assert.deepEqual(detailEvents(undefined), []);
});

test("only the latest request's answer counts, whatever order the answers arrive in", () => {
  const ticket = latestOnly();
  const first = ticket(), second = ticket();
  assert.equal(first(), false);
  assert.equal(second(), true);
});

const keys = (rows) => rows.map((r) => r.key);
const board3 = () => groupTasks({ columns: [
  { key: "in_progress", tasks: [task("P")] },
  { key: "open", tasks: [task("A"), task("B"), task("C"), task("X", 1)] },
  { key: "done", tasks: [task("D")] },
] });

test("the list is one run of rows: each group's heading, its rows, then its show-more row", () => {
  const plain = { narrowed: false, shut: new Set(), expanded: new Set(), shown: { open: 2 } };
  assert.deepEqual(keys(listRows(board3(), plain)),
    ["head:in_progress", "task:P", "head:open", "task:A", "task:B", "more:open", "task:X", "head:done", "task:D"]);
  assert.equal(listRows(board3(), plain).find((r) => r.key === "more:open").cut, 1);
  // a folded group keeps only its heading; an expanded one lists every row and offers to show less
  assert.deepEqual(keys(listRows(board3(), { ...plain, shut: new Set(["open"]) })),
    ["head:in_progress", "task:P", "head:open", "head:done", "task:D"]);
  assert.deepEqual(keys(listRows(board3(), { ...plain, expanded: new Set(["open"]) })).slice(2, 8),
    ["head:open", "task:A", "task:B", "task:C", "more:open", "task:X"]);
  // filtered: nothing folds or cuts, and groups without a match drop out
  const narrowed = filterGroups(board3(), "x", "all");
  assert.deepEqual(keys(listRows(narrowed, { ...plain, narrowed: true, shut: new Set(["open"]) })), ["head:open", "task:X"]);
});

test("a group with no tasks takes no heading", () => {
  const groups = groupTasks({ columns: [{ key: "open", tasks: [task("A")] }, { key: "done", tasks: [task("D")] }] });
  assert.deepEqual(keys(listRows(groups, { narrowed: false, shut: new Set(), expanded: new Set(), shown: {} })),
    ["head:open", "task:A", "head:done", "task:D"]); // no "in progress 0"
});

test("the arrow keys move the selection along the rows and stop at either end", () => {
  const rows = listRows(board3(), { narrowed: false, shut: new Set(), expanded: new Set(), shown: {} });
  assert.equal(moveSelection(rows, null, 1), "head:in_progress"); // nothing picked yet: down starts at the top
  assert.equal(moveSelection(rows, null, -1), "task:D"); // and up at the bottom
  assert.equal(moveSelection(rows, "task:P", 1), "head:open");
  assert.equal(moveSelection(rows, "task:P", -1), "head:in_progress");
  assert.equal(moveSelection(rows, "task:D", 1), "task:D");
  assert.equal(moveSelection(rows, "head:in_progress", -1), "head:in_progress");
  assert.equal(moveSelection(rows, "task:GONE", 1), "head:in_progress"); // a row that left the list
  assert.equal(moveSelection([], null, 1), null);
});

test("keys become the panel's commands: arrows move, Enter opens, Esc goes back, / filters", () => {
  const press = (keystroke, key_char) => keyCommand({ keystroke, key: keystroke, key_char });
  assert.equal(press("down"), "down");
  assert.equal(press("up"), "up");
  assert.equal(press("enter"), "open");
  assert.equal(press("escape"), "back");
  assert.equal(press("/", "/"), "filter");
  assert.equal(press("shift-7", "/"), "filter"); // a layout where / needs shift
  assert.equal(press("cmd-down"), null); // chords stay Herdr's
  assert.equal(press("a", "a"), null);
});

test("Esc steps back one layer: the task shown, then the filter box, then the filter's text", () => {
  assert.equal(escapeStep({ trail: ["A"], inFilter: false, query: "x" }), "pop");
  assert.equal(escapeStep({ trail: [], inFilter: true, query: "x" }), "leave-filter");
  assert.equal(escapeStep({ trail: [], inFilter: false, query: " x " }), "clear-filter");
  assert.equal(escapeStep({ trail: [], inFilter: false, query: "  " }), null);
});

test("a change under the board's folder counts when it is the board or its write-ahead log", () => {
  const db = "/u/.nawaban/nawaban.db";
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db-wal"], db), true);
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db"], db), true);
  assert.equal(boardChanged(["/u/.nawaban"], db), true); // the watched folder itself: anything may have changed
  assert.equal(boardChanged(["/u/.nawaban/nawaban.db-shm"], db), false); // readers, the panel too, touch this
  assert.equal(boardChanged(["/u/.nawaban/backups/nawaban-1.db", "/u/.nawaban/nawaban.old.db"], db), false);
  assert.equal(boardChanged([], db), false);
});

test("the open group counts as its chips do: tasks that can start, then the blocked ones", () => {
  const [working, open, done] = board3(); // open: A, B, C and blocked X
  assert.equal(groupCount(open, "zh"), "3 · 被挡 1"); // the chips read 待认领 3 and 被挡 1
  assert.equal(groupCount(open, "en"), "3 · 1 blocked");
  assert.equal(groupCount({ key: "open", tasks: [task("A")] }, "zh"), "1");
  assert.equal(groupCount(working, "zh"), "1");
  assert.equal(groupCount(done, "en"), "1");
});

test("an event's author reads as you for the user's own decisions, else agent", () => {
  assert.equal(authorLabel("user", "zh"), "你");
  assert.equal(authorLabel("user", "en"), "You");
  assert.equal(authorLabel("76ecefa7-ecd3-4558-9567-badac0af274c", "zh"), "agent");
  assert.equal(authorLabel(null, "en"), "agent");
});

test("a selection that the filter, a refresh or another project hid is no selection", () => {
  const rows = [{ key: "head:open", kind: "head" }, { key: "task:B", kind: "task" }];
  assert.equal(shownSelection(rows, "task:A"), null);
  assert.equal(shownSelection(rows, "task:B"), "task:B");
  assert.equal(shownSelection(rows, null), null);
});
