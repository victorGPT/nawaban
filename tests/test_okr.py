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


def test_a_crash_names_the_error_line_not_the_runtime_footer(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "崩"\ntarget = ">= 1"\n'
        'measure = "printf \'  at x\\\\nError [ERR_MODULE_NOT_FOUND]: no pkg\\\\n  at y\\\\n\\\\nNode.js v26\\\\n\' >&2; exit 1"\n')
    _, out = okr(capsys)
    assert "ERR_MODULE_NOT_FOUND" in line(out, "崩")


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


def test_a_kr_without_a_name_or_with_a_numeric_target_refuses_the_file(repo, capsys):
    path = repo / "docs" / "agents" / "okr.toml"
    path.write_text('[[objective]]\nname = "O"\n[[objective.kr]]\ntarget = ">= 95"\n')
    assert okr(capsys)[0] == 1
    path.write_text('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = 95\n')
    code, out = okr(capsys)
    assert code == 1 and "target" in out


def test_a_measure_printing_bad_bytes_fails_that_kr_only(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "坏字节"\ntarget = ">= 1"\nmeasure = "printf \'\\\\377\'"\n'
        '[[objective.kr]]\nname = "好的"\ntarget = ">= 1"\nmeasure = "echo \'2 today\'"\n')
    code, out = okr(capsys)
    assert code == 0 and "测量失败" in line(out, "坏字节") and line(out, "好的").startswith("  ✓")


@pytest.mark.parametrize("body", [b"\xff", b"objective = 5\n", b'[[objective]]\nname = "O"\nkr = [1]\n',
                                  b'[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = true\n',
                                  b'[[objective]]\nname = "O"\n[[objective.kr]]\nname = 3\ntarget = ">= 1"\n',
                                  b'[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmax_age_days = 1' + b'0' * 5000 + b'\n'])
def test_a_definitions_file_of_the_wrong_shape_is_refused(repo, capsys, body):
    (repo / "docs" / "agents" / "okr.toml").write_bytes(body)
    code, out = okr(capsys)
    assert code == 1 and "okr.toml" in out


def test_a_reading_just_below_the_target_is_missed_however_many_digits(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 9007199254740993"\nmeasure = "echo 9007199254740992 today"\n'
        '[[objective.kr]]\nname = "J"\ntarget = ">= 1.0000000000000001"\nmeasure = "echo 1 today"\n')
    _, out = okr(capsys)
    assert "0/2 达标" in out


def test_a_reading_older_than_max_age_days_is_stale_not_met(repo, capsys):
    import datetime
    d = lambda n: (datetime.date.today() - datetime.timedelta(days=n)).isoformat()
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n'
        f'[[objective.kr]]\nname = "新"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo \'5 {d(2)} report.md\'"\n'
        f'[[objective.kr]]\nname = "旧"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo \'5 {d(10)}\'"\n'
        '[[objective.kr]]\nname = "无日期"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo \'5 latest\'"\n')
    _, out = okr(capsys)
    assert "1/3 达标" in out and line(out, "新").startswith("  ✓")
    assert line(out, "旧").startswith("  ⌛") and "测量过期" in line(out, "旧")
    assert "测量失败" in line(out, "无日期")


@pytest.mark.parametrize("age", ["-1", "true", '"7"', "1.5"])
def test_a_bad_max_age_days_refuses_the_file(repo, capsys, age):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        f'[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmax_age_days = {age}\n')
    code, out = okr(capsys)
    assert code == 1 and "max_age_days" in out


def test_a_reading_with_bad_bytes_or_a_compact_date_never_counts(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n'
        '[[objective.kr]]\nname = "坏截至"\ntarget = ">= 1"\nmeasure = "printf \'2 \\\\377\'"\n'
        '[[objective.kr]]\nname = "紧凑日期"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo 2 $(date +%Y%m%d)"\n')
    _, out = okr(capsys)
    assert "0/2 达标" in out and "测量失败" in line(out, "坏截至") and "测量失败" in line(out, "紧凑日期")


def test_a_nul_in_a_measure_refuses_the_file(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = "echo \\u0000"\n')
    code, out = okr(capsys)
    assert code == 1 and "measure" in out


def test_a_reading_in_scientific_notation_is_read(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = "> 0"\nmeasure = "echo 1e-05 today"\n')
    _, out = okr(capsys)
    assert "1/1 达标" in out
