"""Measure how often a session loads the task skill before acting, and stays away from it when the board is not involved.

Each run reuses the gate evaluation's throwaway repository and loads exactly one plugin checkout.
Tune skill descriptions by reading train runs only; a change is kept when train and test both improve.
Keep --output outside the repository.

    python3 scripts/eval_skill_trigger.py --variant base=<checkout> --variant new=<checkout> \\
        --model sonnet --runs 3 --output <dir>
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import random
import statistics
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_gates  # noqa: E402

CARD = eval_gates.CARD
ACTS = ("Edit", "Write", "Bash")

# (id, should the task skill load, prompt, why a person would call this case hard or plain)
# None marks a case that is not scored: the session banner already answers read-only questions about board state,
# so loading is optional there. They stay listed because the held-out draw below was made over the full list.
CASES = [
    ("named_card_edit", True, f"你正在做看板卡 {CARD}。把 README.md 里的错别字 helo 改成 hello，然后提交。", "names the card; the edit itself looks trivial"),
    ("unnamed_edit", True, "README.md 里有个错别字 helo，帮我改成 hello 然后提交。", "never mentions the board, but the repository has one and the main tree is shared"),
    ("resume", True, f"接着把 {CARD} 做完。", "only a card number, no verb from the description"),
    ("start_work", True, f"看板上 {CARD} 归我了，开始干活吧。", "colloquial start, no claim wording"),
    ("who_is_working", None, "看板上现在谁在做什么？", "read-only question the banner answers"),
    ("card_status", None, f"{CARD} 现在做到哪了？", "read-only question the banner answers"),
    ("create_card", True, "在看板上新建一张卡：首页加载慢，需要排查原因。只建卡，不要改代码。", "plain: asks for a board write"),
    ("handoff", True, f"{CARD} 今天做不完了，README.md 的错别字还没改。把这张卡交接出去，不要改代码。", "either the task skill or the wrap-up skill is right"),
    ("wrap_up", True, "我要关这个窗口了，帮我把手上的活收个尾。", "no card and no board word; only the wrap-up description covers it"),
    ("mark_done", True, f"{CARD} 做完了，把它标成完成。", "plain: asks for a status change"),
    ("new_feature", True, "给这个项目加一个 CONTRIBUTING.md，写三条贡献须知，然后提交。", "new work unrelated to the card this session holds; nothing in the request points at the board"),
    ("small_fix", True, "NOTES.md 第一行应该是 Notes 不是 notes，改一下。", "one-word edit with no board vocabulary and no commit request"),
    ("pick_next", True, f"先别管 {CARD}，看板上还有没有没人做的卡？挑一张给我。", "asks the board for other work"),
    ("blocked", True, f"{CARD} 卡住了，要等产品确认文案。在看板上记一下。", "records a blocker; no code change"),
    ("scope_grows", True, f"做 {CARD} 的时候发现 NOTES.md 的 notes 也该大写，一起改了。", "extra edit under a card; only the card number hints at the board"),
    ("decision", True, f"记一下：{CARD} 决定只改 README.md，不动 NOTES.md。", "records a decision; no code change"),
    ("merge_files", True, "把 NOTES.md 的内容并进 README.md 末尾，删掉 NOTES.md，然后提交。", "multi-file change with no board vocabulary"),
    ("english", True, f"Pick up {CARD} and finish it.", "English request against Chinese skill descriptions"),
    ("cancelled", True, f"{CARD} 不用做了，需求取消了。", "status change phrased as news, not as a command"),
    ("vague_resume", True, "继续昨天没做完的。", "no card number; only the board knows what was unfinished"),
    ("summarise_readme", False, "README.md 里写了什么？用一句话概括。", "plain: reading a file"),
    ("palindrome", False, "用 Python 写一个判断回文的函数，直接贴在回复里，不要建文件。", "plain: nothing touches the repository"),
    ("last_commit", False, "最近一次提交的说明是什么？", "plain: read-only git question"),
    ("explain_worktree", False, "用两三句话解释 git worktree 是什么。", "uses a word from the skill but asks for no task work"),
    ("count_lines", False, "NOTES.md 有几行？", "plain: read-only question about a tracked file"),
    ("task_word", False, "「任务」这个词翻译成英文有哪几种说法？", "uses a word from the description with no board involved"),
    ("claim_word", False, "「认领」和「领取」这两个词有什么区别？", "a verb from the description, asked as a language question"),
    ("kanban_concept", False, "看板方法里的 WIP 上限是什么意思？简单说说。", "kanban as a concept, not this board"),
    ("list_branches", False, "列出这个仓库现在有哪些分支。", "read-only git question near the worktree topic"),
    ("explain_hook", False, "Claude Code 的 PreToolUse hook 是什么时候触发的？一两句话。", "mentions hooks, which this plugin installs, but asks a general question"),
    ("longer_file", False, "README.md 和 NOTES.md 哪个文件更长？", "names the files a card touches but only reads them"),
    ("handoff_word", False, "把「交接」翻译成英文和日文。", "a verb from the wrap-up description, asked as a translation"),
    ("proofread", False, "这句话有没有语病：「我们将在下周完成全部任务的交付」。", "contains task and delivery wording inside quoted text"),
]


def test_ids():
    """A fixed third of each kind is held out; the tuning loop never reads these runs."""
    rng = random.Random(20261010)
    fire = sorted(c[0] for c in CASES if c[1] is not False)
    quiet = sorted(c[0] for c in CASES if c[1] is False)
    return set(rng.sample(fire, 7) + rng.sample(quiet, 4))


def fired(raw):
    """(loaded before the first acting tool call, loaded at any point) for the nawaban skills."""
    acted = early = late = False
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        message = event.get("message") if isinstance(event, dict) else None
        # Some system events carry a plain string as their message.
        for part in (message.get("content") if isinstance(message, dict) else None) or []:
            if not isinstance(part, dict) or part.get("type") != "tool_use":
                continue
            if part.get("name") == "Skill" and "nawaban" in str((part.get("input") or {}).get("skill")):
                late = True
                early = early or not acted
            acted = acted or part.get("name") in ACTS
    return early, late


def run_one(job):
    case, expect, prompt, variant, plugin, model, i, out, split, banner = job
    repo = out / "fixtures" / f"{case}-{variant}-{model}-{i}"
    env = eval_gates.child_env(plugin, banner)
    # The session banner reads this directory; the host's own would leak another project's state into the run.
    env["NAWABAN_STATE_DIR"] = str(repo / ".nawaban" / "state")
    session = str(uuid.uuid4())
    eval_gates.build_fixture(repo, plugin, env, session)
    cmd = ["claude", "-p", prompt, "--model", model, "--session-id", session, "--plugin-dir", str(plugin),
           "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence",
           "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,Skill",
           "--max-budget-usd", "0.5", "--output-format", "stream-json", "--verbose"]
    try:
        raw = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, timeout=600).stdout
    except subprocess.TimeoutExpired as exc:
        raw = (exc.stdout or b"").decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
    (out / "transcripts").mkdir(exist_ok=True)
    (out / "transcripts" / f"{repo.name}.jsonl").write_text(raw)
    return score(raw, case, expect, variant, model, i, split)


def score(raw, case, expect, variant, model, i, split):
    result = {}
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            result = event
    early, late = fired(raw)
    # Loading the skill is a means; fewer rejected tool calls is the outcome it should buy.
    gates = sum('"is_error":true' in line.replace(" ", "") and any(m in line for m in eval_gates.GATE_MARKS[:3])
                for line in raw.splitlines())
    denied = sum('"subtype": "permission_denied"' in line or '"subtype":"permission_denied"' in line for line in raw.splitlines())
    return {"case": case, "expect": expect, "split": split, "variant": variant, "model": model, "run": i,
            "early": early, "late": late, "finished": bool(result) and not result.get("is_error"), "denied": denied, "gates": gates,
            # A skill that should load counts only when it loads before acting; one that should not must never load.
            "ok": early if expect else not late, "cost_usd": result.get("total_cost_usd")}


def summarise(results):
    lines = ["| model | split | variant | cases | correct | 95% CI | should load: loaded first | should not load: stayed out | gate rejections per run | unfinished | permission denials | cost $ |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for model, split, variant in sorted({(r["model"], r["split"], r["variant"]) for r in results}):
        g = [r for r in results if (r["model"], r["split"], r["variant"]) == (model, split, variant)]
        k = sum(r["ok"] for r in g)
        lo, hi = eval_gates.wilson(k, len(g))
        fire = [r for r in g if r["expect"]]
        quiet = [r for r in g if not r["expect"]]
        lines.append(f"| {model} | {split} | {variant} | {len({r['case'] for r in g})} | {k}/{len(g)} | {lo:.2f}-{hi:.2f} | "
                     f"{sum(r['ok'] for r in fire)}/{len(fire)} | {sum(r['ok'] for r in quiet)}/{len(quiet)} | "
                     f"{statistics.mean(r['gates'] for r in g):.2f} | {sum(not r['finished'] for r in g)} | {sum(r['denied'] for r in g)} | {statistics.mean(r['cost_usd'] or 0 for r in g):.3f} |")
    return "\n".join(lines)


def by_case(results):
    lines = ["| model | variant | case | should load | correct | loaded later |", "|---|---|---|---|---|---|"]
    for model, variant, case in sorted({(r["model"], r["variant"], r["case"]) for r in results}):
        g = [r for r in results if (r["model"], r["variant"], r["case"]) == (model, variant, case)]
        lines.append(f"| {model} | {variant} | {case} | {'yes' if g[0]['expect'] else 'no'} | {sum(r['ok'] for r in g)}/{len(g)} | "
                     f"{sum(r['late'] and not r['early'] for r in g)} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variant", action="append", metavar="NAME=CHECKOUT")
    ap.add_argument("--model", action="append")
    ap.add_argument("--regrade", type=Path, help="score the saved transcripts of an earlier run again, without calling a model")
    ap.add_argument("--split", choices=["train", "test", "all"], default="all")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--banner", action="store_true", help="set NAWABAN_CONTEXT_BANNER=1 in the session")
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()

    held = test_ids()
    if args.regrade:
        expects = {case: expect for case, expect, _, _ in CASES}
        results = []
        for path in sorted((args.regrade / "transcripts").glob("*.jsonl")):
            case, variant, model, i = path.stem.rsplit("-", 3)
            if expects.get(case) is None:
                continue  # removed or no longer scored since that run
            results.append(score(path.read_text(), case, expects[case], variant, model, int(i),
                                 "test" if case in held else "train"))
        report(results, args.regrade)
        return
    if not args.variant or not args.model or not args.output:
        ap.error("--variant, --model and --output are required unless --regrade is given")
    out = args.output.resolve() / uuid.uuid4().hex[:8]
    out.mkdir(parents=True)
    jobs = [(case, expect, prompt, v, Path(p).resolve(), m, i, out, "test" if case in held else "train", args.banner)
            for case, expect, prompt, _ in CASES
            if expect is not None and (args.split == "all" or (case in held) == (args.split == "test"))
            for v, p in dict(x.split("=", 1) for x in args.variant).items() for m in args.model for i in range(args.runs)]
    with ThreadPoolExecutor(args.jobs) as pool:
        results = list(pool.map(run_one, jobs))
    report(results, out)


def report(results, out):
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    # Per-case rows for held-out cases stay in results.json only, so a tuning loop reading the summary cannot see them.
    summary = summarise(results) + "\n\n" + by_case([r for r in results if r["split"] == "train"])
    (out / "summary.md").write_text(summary + "\n")
    print(summary)
    print(f"\n{out}")


if __name__ == "__main__":
    main()
