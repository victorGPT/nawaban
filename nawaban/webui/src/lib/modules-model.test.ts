import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyWire, buildIndex, isBlocked, layers, groupByEpic } from "./modules-model.ts";

test("refreshing a scrolled DAG retains dependency endpoints in content coordinates", () => {
  const upstream = { left: 120, right: 370, top: 200, height: 100 };
  const downstream = { left: 420, right: 670, top: 240, height: 100 };
  const viewport = { left: 100, top: 100, scrollLeft: 0, scrollTop: 0 };
  const path = dependencyWire(upstream, downstream, viewport);
  const scroll = (rect: typeof upstream) => ({
    ...rect, left: rect.left - 280, right: rect.right - 280, top: rect.top - 40,
  });
  assert.equal(
    dependencyWire(scroll(upstream), scroll(downstream), { ...viewport, scrollLeft: 280, scrollTop: 40 }),
    path,
  );
});
const data = {
  tasks: [
    { i: "A", t: "上游", s: "open", e: "one" },
    { i: "B", t: "下游", s: "open", e: "two" },
    { i: "C", t: "下下游", s: "open", e: "two" },
    { i: "D", t: "独立", s: "done", e: "two" },
  ],
  deps: [
    ["B", "A"],
    ["C", "B"],
  ] as [string, string][],
};
test("cross-module upstream blocks a task; local layers do not omit loose tasks", () => {
  const index = buildIndex(data);
  assert.equal(isBlocked(data.tasks[1], index), true);
  const layout = layers(
    data.tasks.filter((t) => t.e === "two"),
    index,
  );
  assert.deepEqual(
    layout.cols.map((c) => c.map((t) => t.i)),
    [["B"], ["C"]],
  );
  assert.deepEqual(
    layout.loose.map((t) => t.i),
    ["D"],
  );
  assert.deepEqual(index.downOf.get("A"), ["B"]);
  assert.equal(groupByEpic(data.tasks)[0].epic, "two");
});
