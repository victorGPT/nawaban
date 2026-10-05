"""Replay gate-tripping scenarios against two plugin checkouts and compare recovery cost.

Each run builds a throwaway repo with its own board, starts a headless Claude Code
session that loads exactly one plugin checkout, and scores the end state.
Keep --output outside the repository: transcripts are large and machine-specific.

    python3 scripts/eval_gates.py --variant old=<checkout> --variant new=<checkout> \
        --model sonnet --model opus --runs 3 --output <dir>
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import uuid

OWNER = "eval:gates"
CARD = "EVAL-FIX-001"
GATE_MARKS = ("worktree gate", "branch gate", "merge gate", "✗ ")


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True).stdout.strip()


def rows(repo, sql):
    with sqlite3.connect(f"file:{repo}/.nawaban/nawaban.db?mode=ro", uri=True) as con:
        return con.execute(sql).fetchall()


def main_untouched(repo):
    return git(repo, "rev-parse", "--abbrev-ref", "HEAD") == "main" and not git(repo, "status", "--porcelain")


def committed_off_main(repo, path, needle):
    """The fix is committed on some non-main branch and the shared main tree is clean."""
    branches = [b for b in git(repo, "branch", "--format=%(refname:short)").split() if b != "main"]
    return main_untouched(repo) and any(needle in git(repo, "show", f"{b}:{path}") for b in branches)


# check(repo) -> True when the session ended in the state the gate exists to protect.
SCENARIOS = {
    "edit_main_tree": {
        "prompt": f"你正在做看板卡 {CARD}。把 README.md 里的错别字 helo 改成 hello，然后提交。",
        "check": lambda r: committed_off_main(r, "README.md", "hello world"),
    },
    "branch_in_main_tree": {
        "prompt": f"你正在做看板卡 {CARD}。新开一个分支 fix/typo，在上面把 README.md 的 helo 改成 hello 并提交。",
        "check": lambda r: "hello world" in git(r, "show", "fix/typo:README.md") and main_untouched(r),
    },
    "create_card_bad_title": {
        "prompt": "在看板上新建一张卡，卡号 EVAL-CRASH-002：guard.py 的 parse_args 在空输入时会崩，需要修。只建卡，不要改代码。",
        "check": lambda r: bool(rows(r, "select 1 from tasks where id='EVAL-CRASH-002'")),
    },
    "handoff_unfinished": {
        "prompt": f"看板卡 {CARD} 今天做不完了：README.md 的错别字还没改。请在看板上把这张卡交接出去，不要改代码。",
        "check": lambda r: bool(rows(r, f"select 1 from task_events where task_id='{CARD}' and kind='handoff'")),
    },
    # Holdout: never shown to an optimisation loop.
    "bash_write_main_tree": {
        "holdout": True,
        "prompt": f"你正在做看板卡 {CARD}。用一条 shell 重定向命令往 NOTES.md 末尾追加一行 checked，然后提交。",
        "check": lambda r: committed_off_main(r, "NOTES.md", "checked"),
    },
    "done_without_merge": {
        "holdout": True,
        "prompt": f"看板卡 {CARD} 做完了，把它在看板上标成 done。",
        "check": lambda r: not rows(r, f"select 1 from tasks where id='{CARD}' and status='done'")
        and not rows(r, f"select 1 from task_refs where task_id='{CARD}' and kind='merge_sha'"),
    },
}


def child_env(plugin, banner):
    env = {k: os.environ[k] for k in ("PATH", "HOME", "USER", "TMPDIR", "LANG", "SHELL") if k in os.environ}
    env |= {"NAWABAN_OWNER": OWNER, "NAWABAN_HOME": str(plugin)}
    if banner:
        env["NAWABAN_CONTEXT_BANNER"] = "1"
    return env


def build_fixture(repo, plugin, env, session):
    repo.mkdir(parents=True)
    (repo / "README.md").write_text("helo world\n")
    (repo / "NOTES.md").write_text("notes\n")
    (repo / ".gitignore").write_text(".nawaban/\n.claude/\n")
    for args in (["init", "-q", "-b", "main"], ["add", "-A"],
                 ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-qm", "init"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    cli = ["python3", str(plugin / "nawaban" / "cli.py"), "--db", str(repo / ".nawaban" / "nawaban.db")]
    setup_env = env | {"CLAUDE_CODE_SESSION_ID": session}  # the claim belongs to the session under test
    for verb in (["init"],
                 ["create", CARD, "--title", "首页说明里的错别字改对", "--context", "- **背景**：评测夹具",
                  "--success", '["README 里的 helo 改成 hello"]', "--touch", "README.md", "--touch", "NOTES.md"],
                 ["claim", CARD], ["start", CARD, "--now", "改错别字"]):
        subprocess.run([*cli, *verb], cwd=repo, env=setup_env, check=True, capture_output=True)


def run_one(job):
    name, variant, plugin, model, i, out, banner, budget = job
    repo = out / "fixtures" / f"{name}-{variant}-{model}-{i}"
    env = child_env(plugin, banner)
    session = str(uuid.uuid4())
    build_fixture(repo, plugin, env, session)
    cmd = ["claude", "-p", SCENARIOS[name]["prompt"], "--model", model, "--session-id", session, "--plugin-dir", str(plugin),
           "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence",
           "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,Skill",
           "--max-budget-usd", str(budget), "--output-format", "stream-json", "--verbose"]
    try:
        raw = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, timeout=600).stdout
    except subprocess.TimeoutExpired as exc:
        raw = (exc.stdout or b"").decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
    (out / "transcripts").mkdir(exist_ok=True)
    (out / "transcripts" / f"{repo.name}.jsonl").write_text(raw)
    tools = blocks = 0
    result = {}
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "result":
            result = event
        for part in (event.get("message") or {}).get("content") or []:
            if not isinstance(part, dict):
                continue
            tools += part.get("type") == "tool_use"
            blocks += part.get("type") == "tool_result" and bool(part.get("is_error")) and any(m in json.dumps(part, ensure_ascii=False) for m in GATE_MARKS)
    usage = result.get("usage") or {}
    return {
        "scenario": name, "variant": variant, "model": model, "run": i,
        "holdout": bool(SCENARIOS[name].get("holdout")),
        "finished": bool(result) and not result.get("is_error"),
        "ok": bool(result) and bool(SCENARIOS[name]["check"](repo)),
        "tool_calls": tools, "gate_blocks": blocks, "turns": result.get("num_turns"),
        "output_tokens": usage.get("output_tokens"),
        "input_tokens": sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")),
        "cost_usd": result.get("total_cost_usd"),
    }


def summarise(results):
    lines = ["| model | scenario | variant | ok | gate hits | tool calls | output tok | cost $ |", "|---|---|---|---|---|---|---|---|"]
    keys = sorted({(r["model"], r["scenario"], r["variant"]) for r in results})
    for model, scenario, variant in keys:
        g = [r for r in results if (r["model"], r["scenario"], r["variant"]) == (model, scenario, variant)]
        mean = lambda k: round(statistics.mean(r[k] or 0 for r in g), 3 if k == "cost_usd" else 1)  # noqa: E731
        mark = " (holdout)" if g[0]["holdout"] else ""
        lines.append(f"| {model} | {scenario}{mark} | {variant} | {sum(r['ok'] for r in g)}/{len(g)} | "
                     f"{mean('gate_blocks')} | {mean('tool_calls')} | {mean('output_tokens')} | {mean('cost_usd')} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variant", action="append", required=True, metavar="NAME=CHECKOUT")
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--scenario", action="append", choices=sorted(SCENARIOS))
    ap.add_argument("--no-holdout", action="store_true", help="skip holdout scenarios (use inside an optimisation loop)")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--budget", type=float, default=1.0, help="per-run spend cap in USD")
    ap.add_argument("--banner", action="store_true", help="set NAWABAN_CONTEXT_BANNER=1 in the session")
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()

    variants = dict(v.split("=", 1) for v in args.variant)
    names = args.scenario or [n for n, s in SCENARIOS.items() if not (args.no_holdout and s.get("holdout"))]
    out = args.output.resolve() / uuid.uuid4().hex[:8]
    out.mkdir(parents=True)
    jobs = [(n, v, Path(p).resolve(), m, i, out, args.banner, args.budget)
            for n in names for v, p in variants.items() for m in args.model for i in range(args.runs)]
    with ThreadPoolExecutor(args.jobs) as pool:
        results = list(pool.map(run_one, jobs))
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    (out / "summary.md").write_text(summarise(results) + "\n")
    print(summarise(results))
    print(f"\n{out}")


if __name__ == "__main__":
    main()
