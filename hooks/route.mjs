import { execFileSync } from "node:child_process";
import { cliFor, repoName } from "../herdr/mods/nawaban-board/logic.js";

const CLI_EVERY_PROJECT_HAD_BEFORE = "old";

function projectAt(dir) {
  try {
    return repoName(execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

const project = projectAt(process.argv[2] || ".");
const via = process.env.NAWABAN_CLI || cliFor(project);
console.log(via === "board" && project ? `board ${project}` : CLI_EVERY_PROJECT_HAD_BEFORE);
