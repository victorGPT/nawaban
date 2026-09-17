import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskSignal,
  inboxMatches,
  navigateTask,
  boardItems,
  scopePaths,
  contextPresentation,
  taskIdFromHref,
  textItems, liveAge, contextMarkdown } from "./nawaban-model.ts";

test("legacy task text is one readable item and structured lists retain their items", () => {
  assert.deepEqual(textItems("Old scope text"), ["Old scope text"]);
  assert.deepEqual(textItems(["A", "B"]), ["A", "B"]);
  assert.deepEqual(textItems(null), []);
  assert.deepEqual(textItems(undefined), []);
});

test("only a working signal is green; pending decisions take precedence", () => {
  assert.equal(
    taskSignal({ live: { tier: "working", age_s: 2 }, waiting_on: null }, false)
      .kind,
    "working",
  );
  assert.equal(
    taskSignal({ live: { tier: "working", age_s: 2 }, waiting_on: null }, true)
      .kind,
    "decision",
  );
  assert.equal(
    taskSignal({ live: null, waiting_on: null }, false).kind,
    "unknown",
  );
  assert.equal(
    taskSignal({ live: { tier: "idle", age_s: 180 }, waiting_on: null }, false)
      .kind,
    "idle",
  );
  assert.equal(
    taskSignal(
      { live: { tier: "cold", age_s: 99999 }, waiting_on: null },
      false,
    ).kind,
    "unresponsive",
  );
});
test("task links find related inbox entries even when question omits task ID", () => {
  assert.equal(
    inboxMatches(
      { id: 1, question: "\u8bf7\u9a8c\u6536", evidence: "\u94fe\u63a5", task_ids: ["TASK-A"] },
      "task-a",
    ),
    true,
  );
});
test("task history supports related task navigation and back without duplicate entries", () => {
  let path = navigateTask([], { type: "open", id: "A" });
  path = navigateTask(path, { type: "open", id: "B" });
  path = navigateTask(path, { type: "open", id: "B" });
  assert.deepEqual(navigateTask(path, { type: "back" }), ["A"]);
  assert.deepEqual(navigateTask(path, { type: "close" }), []);
});
test("board preserves Assigned as a separate column and source status", () => {
  const tasks = boardItems({
    columns: [
      { key: "claimed", tasks: [{ id: "A", status: "claimed" }] },
      { key: "in_progress", tasks: [{ id: "B", status: "in_progress" }] },
    ],
  } as never);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.column, t.status]),
    [
      ["A", "claimed", "claimed"],
      ["B", "in_progress", "in_progress"],
    ],
  );
});

test("scope display separates legacy comma-packed paths without changing the source", () => {
  const source = ["src/a.py,lib/b.ts", "tests/c.py", "src/d.py\n src/e.py "];
  assert.deepEqual(scopePaths(source), [
    "src/a.py",
    "lib/b.ts",
    "tests/c.py",
    "src/d.py",
    "src/e.py",
  ]);
  assert.equal(source[0], "src/a.py,lib/b.ts");
  assert.deepEqual(scopePaths(null), []);
});

test("context presentation uses explicit latest formatting records, preserving ordinary task prose", () => {
  const a = {
    id: 1,
    question: "\u6765\u7531\u6392\u7248（Markdown）",
    verdict: "## \u6539\u52a8\u6e05\u5355\n- A",
  };
  const b = {
    id: 2,
    question: "\u6765\u7531\u6392\u7248（Markdown）",
    verdict: "## \u6539\u52a8\u6e05\u5355\n- B",
  };
  assert.equal(contextPresentation([a, b]), b.verdict);
  assert.equal(
    contextPresentation([{ ...b, question: "\u6267\u884c\u524d\u63d0\u662f\u5426\u5177\u5907" }]),
    null,
  );
  assert.equal(contextPresentation([]), null);
});

test("Markdown task links recognize local task routes while leaving external URLs alone", () => {
  assert.equal(
    taskIdFromHref("?task=DEMO-CARDS-001"),
    "DEMO-CARDS-001",
  );
  assert.equal(taskIdFromHref("https://example.com/?task=A"), null);
  assert.equal(taskIdFromHref(undefined), null);
});

test("live age reads as a relative time and unknown stays silent", () => {
  assert.equal(liveAge(null), null);
  assert.equal(liveAge(30), "Active just now");
  assert.equal(liveAge(180), "Last active 3 minutes ago");
  assert.equal(liveAge(7200), "Last active 2 hours ago");
  assert.equal(liveAge(3 * 86400 + 5), "Last active 3 days ago");
});

test("plain line-separated context renders as a bullet list with bold labels", () => {
  assert.equal(
    contextMarkdown("\u7528\u6237 2026-09-17:\u8dd1\u4e00\u4e2a Evals\n\n\u80cc\u666f:\u5b98\u65b9\u5df2\u786e\u8ba4\n\u89c1 https://x.io \u8bf4\u660e"),
    "- **\u7528\u6237 2026-09-17**:\u8dd1\u4e00\u4e2a Evals\n- **\u80cc\u666f**:\u5b98\u65b9\u5df2\u786e\u8ba4\n- \u89c1 https://x.io \u8bf4\u660e",
  );
});
test("context that is already Markdown or a single line stays unchanged", () => {
  assert.equal(contextMarkdown("## \u76ee\u6807\n\u505a\u5b8c"), "## \u76ee\u6807\n\u505a\u5b8c");
  assert.equal(contextMarkdown("- a\n- b"), "- a\n- b");
  assert.equal(contextMarkdown("\u4e00\u53e5\u8bdd\u6765\u7531"), "\u4e00\u53e5\u8bdd\u6765\u7531");
  assert.equal(contextMarkdown("https://x.io\n\u7b2c\u4e8c\u884c"), "- https://x.io\n- \u7b2c\u4e8c\u884c");
});
