import json, os, subprocess
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "leader-index.sh"


def _run(tmp_path, labels, branch=None, rules_file="orchestrator.md", hc_exit=0):
    bin_ = tmp_path / "bin"; bin_.mkdir(parents=True, exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': labels})}'\nexit {hc_exit}\n"); (bin_ / "hc").chmod(0o755)
    proj = tmp_path / "p"; (proj / "docs/agents").mkdir(parents=True, exist_ok=True)
    (proj / f"docs/agents/{rules_file}").write_text("规矩正文\n")
    if branch:
        subprocess.run(["git", "init", "-q", "-b", branch, str(proj)], check=True)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1", "CLAUDE_PROJECT_DIR": str(proj)}
    return subprocess.run(["sh", str(HOOK)], cwd=tmp_path, env=env, capture_output=True, text=True).stdout


def test_a_declared_orchestrator_gets_the_repositorys_orchestrator_rules_or_the_older_leader_md(tmp_path):
    assert "规矩正文" in _run(tmp_path, {"role": "orchestrator"})
    assert "规矩正文" in _run(tmp_path / "old", {"role": "orchestrator"}, rules_file="leader.md")


def test_an_undeclared_terminal_gets_nothing(tmp_path):
    assert _run(tmp_path, {"where": "roubao"}) == ""
    assert _run(tmp_path / "w", {"role": "worker"}) == ""


def test_an_orchestrator_is_told_when_the_repository_is_off_main(tmp_path):
    assert "不在 main" in _run(tmp_path, {"role": "orchestrator"}, branch="fix/x")
    assert "不在 main" not in _run(tmp_path / "m", {"role": "orchestrator"}, branch="main")


def test_nothing_when_hc_fails_even_if_it_printed_the_label(tmp_path):
    assert _run(tmp_path, {"role": "orchestrator"}, hc_exit=7) == ""


DECLARE = HOOK.parent / "orchestrator-declare.sh"
GUARD = HOOK.parent / "orchestrator-guard.sh"


def _declare(tmp_path, prompt, terminal="t1"):
    bin_ = tmp_path / "bin"; bin_.mkdir(parents=True, exist_ok=True)
    log = tmp_path / "hc.log"
    # the fake hc records each call; `get` answers with the label only once `label` has run
    (bin_ / "hc").write_text(
        f'#!/bin/sh\necho "$@" >> {log}\n'
        f'if [ "$1" = get ]; then grep -q "^label" {log} && echo \'{{"labels":{{"role":"orchestrator"}}}}\' || echo \'{{}}\'; fi\n')
    (bin_ / "hc").chmod(0o755)
    proj = tmp_path / "p"; (proj / "docs/agents").mkdir(parents=True, exist_ok=True)
    (proj / "docs/agents/orchestrator.md").write_text("规矩正文\n")
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": terminal, "CLAUDE_PROJECT_DIR": str(proj)}
    out = subprocess.run(["sh", str(DECLARE)], input=json.dumps({"prompt": prompt}), cwd=tmp_path, env=env, capture_output=True, text=True).stdout
    return out, (log.read_text() if log.exists() else "")


def test_the_owner_typing_the_command_labels_the_terminal_and_loads_the_rules(tmp_path):
    out, calls = _declare(tmp_path, "/nawaban:orchestrator")
    assert "label t1 role=orchestrator" in calls and "已给终端 t1" in out and "规矩正文" in out


def test_any_other_prompt_labels_nothing(tmp_path):
    out, calls = _declare(tmp_path, "继续推进 /nawaban:orchestrator 的事")
    assert out == "" and calls == ""


def test_outside_herdr_the_declaration_says_it_failed(tmp_path):
    out, calls = _declare(tmp_path, "/nawaban:orchestrator", terminal="")
    assert "声明失败" in out and calls == ""


def _guard(command):
    return subprocess.run(["sh", str(GUARD)], input=json.dumps({"tool_input": {"command": command}}), capture_output=True, text=True)


def test_the_model_cannot_set_or_clear_the_role_label():
    for cmd in ("hc label t5 role=orchestrator", "hc label t23 role=", "cd x && hc label --json t5 role=x", "hc label t1 'role'=orchestrator", "hc label t1 \\\n  role=orchestrator", 'hc label t1 "role=orchestrator"'):
        r = _guard(cmd)
        assert r.returncode == 2 and "手敲" in r.stderr, cmd


def test_other_hc_commands_pass():
    for cmd in ("hc label t5 where=roubao", "hc ls --json", "echo role=x; hc get t1"):
        assert _guard(cmd).returncode == 0, cmd


COMMENT_GUARD = HOOK.parent / "comment-guard.sh"


def _comment_guard(command):
    return subprocess.run(["sh", str(COMMENT_GUARD)], input=json.dumps({"tool_input": {"command": command}}),
                          capture_output=True, text=True)


def test_a_hand_written_state_comment_is_pointed_at_nawaban():
    for cmd in ('gh issue comment 950 --body "进展：PR 合了"', "gh issue comment 950 -b '认领：s1（hc t3）'",
                'gh issue comment 950 --body "$(cat <<EOF\n待决：定 A\nEOF\n)"', 'gh issue comment 9 --body="已决：A"',
                'gh issue comment 9 --body "**决定**：用 B"', 'cd x && GH_TOKEN=t gh issue comment 9 --body "进展：y"', 'gh issue comment 9 --body "总结\n决定（e8）：B"'):
        r = _comment_guard(cmd)
        assert r.returncode == 2 and "event '#N'" in r.stderr and "cli.py" in r.stderr, cmd


def test_other_comments_and_commands_pass():
    for cmd in ('gh issue comment 950 --body "看了，没问题"', 'gh issue view 950', 'echo "进展：x"',
                'gh issue comment 9 --body "这一步的进展：见上"',
                "printf '%s\\n' 'gh issue comment 9 --body 进展：x'"):
        assert _comment_guard(cmd).returncode == 0, cmd


def test_declaring_clears_the_old_orchestrator_in_the_same_repository_only(tmp_path):
    proj = tmp_path / "p"; (proj / "docs/agents" / "sub").mkdir(parents=True)
    other, inner = tmp_path / "q", proj / "inner"
    for r in (proj, other, inner):
        subprocess.run(["git", "init", "-q", str(r)], check=True)
    bin_ = tmp_path / "bin"; bin_.mkdir()
    log = tmp_path / "hc.log"
    ls = {"terminals": [{"address": a, "cwd": c} for a, c in
                        [("t1", str(proj)), ("t2", str(proj / "docs/agents/sub")), ("t3", str(other)), ("t4", str(inner)), ("t5", str(proj) + "x")]]}
    (bin_ / "hc").write_text(
        f'#!/bin/sh\necho "$@" >> {log}\n'
        f'case "$1" in ls) echo \'{json.dumps(ls)}\';; get) echo \'{{"labels":{{"role":"orchestrator"}}}}\';; esac\n')
    (bin_ / "hc").chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1", "CLAUDE_PROJECT_DIR": str(proj)}
    out = subprocess.run(["sh", str(DECLARE)], input=json.dumps({"prompt": "/nawaban:orchestrator"}),
                         cwd=tmp_path, env=env, capture_output=True, text=True).stdout
    calls = log.read_text().splitlines()
    assert "label t2 role=" in calls and "已摘掉同仓库旧编排者 t2" in out
    assert not {"label t1 role=", "label t3 role=", "label t4 role=", "label t5 role="} & set(calls)
