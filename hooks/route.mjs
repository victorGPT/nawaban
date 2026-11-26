import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cliFor, repoName } from "../herdr/mods/nawaban-board/logic.js";

const OLD_CLI = "old";

function gitCommonDirAt(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function tracksOnGithub(repoRoot) {
  try {
    const lines = readFileSync(join(repoRoot, "docs/agents/issue-tracker.md"), "utf8").split("\n");
    return (lines.find((l) => l.startsWith("#")) ?? "").includes("GitHub");
  } catch {
    return false;
  }
}

function mainCheckoutThenDirAndAncestors(dir, repoRoot) {
  const chain = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    chain.push(d);
    if (d === dirname(d)) break;
  }
  return repoRoot ? [repoRoot, ...chain] : chain;
}

function oldCliFindsABoard(dir, repoRoot) {
  if (process.env.NAWABAN_DB) return true;
  const holder = mainCheckoutThenDirAndAncestors(dir, repoRoot).find((d) => statSync(join(d, ".nawaban"), { throwIfNoEntry: false })?.isDirectory());
  return holder !== undefined && existsSync(join(holder, ".nawaban", "nawaban.db"));
}

function syncedFromGithubOnThisMachine(project) {
  const boardDir = process.env.NAWABAN_BOARD_DIR || join(homedir(), ".nawaban", "board");
  try {
    return Object.entries(JSON.parse(readFileSync(join(boardDir, "github-sync.json"), "utf8")).repos ?? {})
      .some(([repo, channel]) => channel === project && existsSync(join(boardDir, "github-sync", `${encodeURIComponent(repo)}.switched.json`)));
  } catch {
    return false;
  }
}

function trackerOf(dir, gitCommonDir) {
  const project = repoName(gitCommonDir);
  if (process.env.NAWABAN_CLI) return process.env.NAWABAN_CLI;
  if (syncedFromGithubOnThisMachine(project)) return "board";
  if (cliFor(project) === "board") return "board";
  const repoRoot = dirname(gitCommonDir);
  return tracksOnGithub(repoRoot) || oldCliFindsABoard(dir, repoRoot) ? OLD_CLI : "board";
}

const dir = process.argv[2] || ".";
const gitCommonDir = gitCommonDirAt(dir);
const project = gitCommonDir && repoName(gitCommonDir);
console.log(project && trackerOf(dir, gitCommonDir) === "board" ? `board ${project}` : OLD_CLI);
