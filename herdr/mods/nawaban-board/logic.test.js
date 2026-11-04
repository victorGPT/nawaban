import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTasks, projectFor, resolveLang, filterGroups, ago, shortId, linkParts, eventMarkdown, detailEvents, isBlocked } from "./logic.js";

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
