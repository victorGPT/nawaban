"""`nawaban okr`: Progress computed from each KR's measure, never narrated (spec NAWABAN-OKR, ticket 03)."""

import subprocess

import pytest

from nawaban import cli

OKR = """
[[objective]]
name = "听得懂需求"

[[objective.kr]]
name = "意图准确率"
target = ">= 95"
unit = "%"
measure = "echo '进度日志'; echo '100.0 2026-11-17'"

[[objective.kr]]
name = "L1 首位"
target = ">= 95"
unit = "%"
measure = "echo '89 2026-11-17'"

[[objective.kr]]
name = "边界难例"
target = ">= 80"

[[objective]]
name = "推荐能减少筛选"

[[objective.kr]]
name = "硬条件违反"
target = "<= 0"
measure = "echo 'missing data' >&2; exit 3"

[[objective.kr]]
name = "没写日期"
target = ">= 1"
measure = "echo 5"

[[objective.kr]]
name = "不是数"
target = ">= 1"
measure = "echo 'n/a 2026-11-17'"
"""


@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "docs" / "agents").mkdir(parents=True)
    (tmp_path / "docs" / "agents" / "okr.toml").write_text(OKR)
    for args in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "okr"]):
        subprocess.run(["git", *args], cwd=tmp_path, check=True)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def okr(capsys):
    code = cli.main(["okr"])
    out = capsys.readouterr()
    return code, out.out + out.err


def line(out, name):
    return next(l for l in out.splitlines() if name in l)


def test_a_kr_counts_as_met_only_when_its_measured_value_meets_the_target(repo, capsys):
    code, out = okr(capsys)
    assert code == 0, out
    assert "听得懂需求 · 1/3 达标" in out and "推荐能减少筛选 · 0/3 达标" in out
    assert line(out, "意图准确率").startswith("  ✓") and "100.0% / >= 95%" in out and "截至 2026-11-17" in out
    assert line(out, "L1 首位").startswith("  ✗") and "89.0% / >= 95%" in out


def test_no_measure_is_untested_and_a_broken_measure_says_why(repo, capsys):
    _, out = okr(capsys)
    assert "未测" in line(out, "边界难例")
    assert "测量失败" in line(out, "硬条件违反") and "missing data" in line(out, "硬条件违反")
    assert "测量失败" in line(out, "没写日期") and "测量失败" in line(out, "不是数")


def test_a_slow_measure_fails_instead_of_hanging(repo, capsys, monkeypatch):
    monkeypatch.setattr(cli, "MEASURE_TIMEOUT", 0.5)
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "慢"\ntarget = ">= 1"\nmeasure = "sleep 5"\n')
    _, out = okr(capsys)
    assert "测量失败" in line(out, "慢") and "超时" in line(out, "慢")


def test_the_header_names_the_definitions_commit_and_flags_uncommitted_edits(repo, capsys):
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    _, out = okr(capsys)
    assert head in out.splitlines()[0] and "未提交" not in out.splitlines()[0]
    (repo / "docs" / "agents" / "okr.toml").write_text(OKR.replace(">= 95", ">= 90", 1))
    _, out = okr(capsys)
    assert "未提交" in out.splitlines()[0]


@pytest.mark.parametrize("target", ["95", "=> 95", ">= abc", ""])
def test_a_malformed_target_refuses_the_whole_file(repo, capsys, target):
    (repo / "docs" / "agents" / "okr.toml").write_text(OKR.replace('target = ">= 80"', f'target = "{target}"'))
    code, out = okr(capsys)
    assert code == 1 and "边界难例" in out and "target" in out


def test_no_definitions_file_is_refused(tmp_path, monkeypatch, capsys):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    monkeypatch.chdir(tmp_path)
    code, out = okr(capsys)
    assert code == 1 and "docs/agents/okr.toml" in out
