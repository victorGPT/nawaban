// Which CLI a hook runs for the repository at <dir>: prints "board <project>" (node board/src/cli.ts) or
// "old" (nawaban/cli.py). The rule is the panel's, cliFor in herdr/mods/nawaban-board/logic.js, so hooks
// and panel send a project to the same CLI. NAWABAN_CLI=board|old overrides it (tests, a way back).
// Anything that fails here (no git, no repository) is "old", the CLI every project had before.
import { execFileSync } from "node:child_process";
import { cliFor, repoName } from "../herdr/mods/nawaban-board/logic.js";

let project = null;
try {
  project = repoName(execFileSync("git", ["-C", process.argv[2] || ".", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch {}
const via = process.env.NAWABAN_CLI || cliFor(project);
console.log(via === "board" && project ? `board ${project}` : "old");
