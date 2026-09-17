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
      { id: 1, question: "请验收", evidence: "链接", task_ids: ["TASK-A"] },
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
test("board merges claimed into in progress while preserving source status", () => {
  const tasks = boardItems({
    columns: [
      { key: "claimed", tasks: [{ id: "A", status: "claimed" }] },
      { key: "in_progress", tasks: [{ id: "B", status: "in_progress" }] },
    ],
  } as never);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.column, t.status]),
    [
      ["A", "in_progress", "claimed"],
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
    question: "来由排版（Markdown）",
    verdict: "## 改动清单\n- A",
  };
  const b = {
    id: 2,
    question: "来由排版（Markdown）",
    verdict: "## 改动清单\n- B",
  };
  assert.equal(contextPresentation([a, b]), b.verdict);
  assert.equal(
    contextPresentation([{ ...b, question: "执行前提是否具备" }]),
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
  assert.equal(liveAge(30), "刚刚有活动");
  assert.equal(liveAge(180), "最后活动 3 分钟前");
  assert.equal(liveAge(7200), "最后活动 2 小时前");
  assert.equal(liveAge(3 * 86400 + 5), "最后活动 3 天前");
});

test("plain line-separated context renders as a bullet list with bold labels", () => {
  assert.equal(
    contextMarkdown("用户 2026-09-17:跑一个 Evals\n\n背景:官方已确认\n见 https://x.io 说明"),
    "- **用户 2026-09-17**:跑一个 Evals\n- **背景**:官方已确认\n- 见 https://x.io 说明",
  );
});
test("context that is already Markdown or a single line stays unchanged", () => {
  assert.equal(contextMarkdown("## 目标\n做完"), "## 目标\n做完");
  assert.equal(contextMarkdown("- a\n- b"), "- a\n- b");
  assert.equal(contextMarkdown("一句话来由"), "一句话来由");
  assert.equal(contextMarkdown("https://x.io\n第二行"), "- https://x.io\n- 第二行");
});
