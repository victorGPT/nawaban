import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTasks, projectFor, resolveLang } from "./logic.js";

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
