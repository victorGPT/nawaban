import assert from "node:assert/strict";
import test from "node:test";
import { readBoardDisplay, writeBoardDisplay, sortBoardTasks } from "./board-display.ts";
import type { BoardTask } from "./types.ts";

test("URL preferences win per key, including an intentional empty selection", () => {
  const display = readBoardDisplay("?boardColumns=&boardFields=id&boardSort=title", "boardColumns=done&boardFields=module&boardDensity=compact");
  assert.deepEqual(display, { columns: [], fields: ["id"], sort: "title", compact: true });
  const params = new URLSearchParams("project=demo&task=TASK-1&layout=list");
  writeBoardDisplay(params, display);
  assert.equal(params.get("project"), "demo");
  assert.equal(params.get("task"), "TASK-1");
  assert.equal(params.get("layout"), "list");
  assert.deepEqual(readBoardDisplay(params.toString(), null), display);
});

test("unknown and duplicate values cannot introduce columns or fields", () => {
  assert.deepEqual(readBoardDisplay("?boardColumns=done,unknown,done&boardFields=id,other,id&boardSort=bad&boardDensity=bad", null),
    { columns: ["done"], fields: ["id"], sort: "default", compact: false });
  assert.deepEqual(readBoardDisplay("", "invalid-old-value").columns, ["open", "in_progress", "staging-verified", "done"]);
});

test("sorts preserve task identity and do not mutate the backend order", () => {
  const tasks = [
    { id: "A", title: "Zulu", active_at: 1, created_at: 3 },
    { id: "B", title: "Alpha", active_at: 3, created_at: 1 },
    { id: "C", title: "Beta", active_at: 2, created_at: 2 },
  ] as BoardTask[];
  const ids = (sort: "default" | "updated" | "created" | "title") => sortBoardTasks(tasks, sort, "en").map((task) => task.id);
  assert.deepEqual(ids("updated"), ["B", "C", "A"]);
  assert.deepEqual(ids("created"), ["A", "C", "B"]);
  assert.deepEqual(ids("title"), ["B", "C", "A"]);
  assert.deepEqual(ids("default"), ["A", "B", "C"]);
  assert.equal(sortBoardTasks(tasks, "updated", "en")[0], tasks[1]);
  assert.deepEqual(tasks.map((task) => task.id), ["A", "B", "C"]);
});
