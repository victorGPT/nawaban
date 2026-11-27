import { execFileSync } from "node:child_process";
import { repoName } from "../herdr/mods/nawaban-board/logic.js";

function gitCommonDirAt(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const gitCommonDir = gitCommonDirAt(process.argv[2] || ".");
if (gitCommonDir) console.log(`board ${repoName(gitCommonDir)}`);
