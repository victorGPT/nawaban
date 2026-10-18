import { test } from "node:test";
import assert from "node:assert/strict";
import {
  navigateTask,
  boardItems,
  linkParts,
  showsProgress,
  splitCriteria,
  taskIdFromHref,
} from "./nawaban-model.ts";

test("task history supports related task navigation and back without duplicate entries", () => {
  let path = navigateTask([], { type: "open", id: "A" });
  path = navigateTask(path, { type: "open", id: "B" });
  path = navigateTask(path, { type: "open", id: "B" });
  assert.deepEqual(navigateTask(path, { type: "back" }), ["A"]);
  assert.deepEqual(navigateTask(path, { type: "close" }), []);
});

test("board data keeps each task's source column and derived status", () => {
  const tasks = boardItems({
    columns: [
      { key: "open", tasks: [{ id: "A", status: "open" }] },
      { key: "in_progress", tasks: [{ id: "B", status: "in_progress" }] },
      { key: "done", tasks: [] },
    ],
  } as never);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.column, t.status]),
    [
      ["A", "open", "open"],
      ["B", "in_progress", "in_progress"],
    ],
  );
});

test("the acceptance-criteria section is lifted out of the body up to the next heading", () => {
  const body = "## What to build\nA page\n\n## Acceptance criteria\n- loads\n- reads\n\n## Notes\nlater";
  assert.deepEqual(splitCriteria(body), {
    body: "## What to build\nA page\n\n## Notes\nlater",
    criteria: "- loads\n- reads",
  });
});

test("criteria at the end of the body, in Chinese, or with deeper subheadings stay whole", () => {
  assert.deepEqual(splitCriteria("\u80cc\u666f\n\n## \u9a8c\u6536\u6807\u51c6\n- \u53ef\u4ee5"),
    { body: "\u80cc\u666f", criteria: "- \u53ef\u4ee5" });
  assert.deepEqual(splitCriteria("## Acceptance Criteria\n### UI\n- a\n# Next\nx"), {
    body: "# Next\nx",
    criteria: "### UI\n- a",
  });
});

test("a body without criteria, or with an empty criteria section, renders unchanged", () => {
  assert.deepEqual(splitCriteria("just prose"), { body: "just prose", criteria: null });
  assert.deepEqual(splitCriteria(""), { body: "", criteria: null });
  assert.equal(splitCriteria("Intro\n## Acceptance criteria\n").criteria, null);
});

test("a link body splits into kind, value and note, and a bare URL has no kind", () => {
  assert.deepEqual(linkParts("pr: https://example.test/pull/1"),
    { kind: "pr", value: "https://example.test/pull/1", note: null });
  assert.deepEqual(linkParts("merge_sha:abc123 · merged by review"),
    { kind: "merge_sha", value: "abc123", note: "merged by review" });
  assert.deepEqual(linkParts("https://example.test/a"),
    { kind: null, value: "https://example.test/a", note: null });
  assert.deepEqual(linkParts("docs/adr/0001.md"),
    { kind: null, value: "docs/adr/0001.md", note: null });
});

test("only an unclosed task presents its latest note as current progress", () => {
  assert.equal(showsProgress("open"), true);
  assert.equal(showsProgress("in_progress"), true);
  assert.equal(showsProgress("done"), false);
  assert.equal(showsProgress("cancelled"), false);
});

test("Markdown task links recognize local task routes while leaving external URLs alone", () => {
  assert.equal(
    taskIdFromHref("?task=DEMO-CARDS-001"),
    "DEMO-CARDS-001",
  );
  assert.equal(taskIdFromHref("https://example.com/?task=A"), null);
  assert.equal(taskIdFromHref(undefined), null);
});
