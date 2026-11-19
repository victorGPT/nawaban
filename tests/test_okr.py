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


def test_a_python_crash_names_the_exception_not_a_traceback_path(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "崩"\ntarget = ">= 1"\n'
        'measure = "python3 -c \'exec(compile(\\"1/0\\", \\"errors.py\\", \\"exec\\"))\'"\n')
    _, out = okr(capsys)
    assert "ZeroDivisionError" in line(out, "崩")


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


# ── readings kept on the board, json okr, attention (spec NAWABAN-OKRP, ticket 01) ──

import json
import sqlite3
from contextlib import closing


@pytest.fixture
def board(tmp_path):
    db = tmp_path / "b" / ".nawaban" / "nawaban.db"
    assert cli.main(["--db", str(db), "init"]) == 0
    return db


def rows(db, table="kr_readings"):
    with closing(sqlite3.connect(db)) as con:
        return con.execute(f"SELECT * FROM {table}").fetchall()



def test_an_old_board_is_backed_up_and_migrated_on_open_keeping_its_tasks(board, capsys):
    assert cli.main(["--db", str(board), "create", "T", "--title", "留下", "--body", ""]) == 0
    with closing(sqlite3.connect(board)) as con:  # back to what a version-1 board looks like
        con.executescript("DROP TABLE kr_readings; DROP TABLE okr_accepts; PRAGMA user_version=1;")
    capsys.readouterr()
    assert cli.main(["--db", str(board), "list"]) == 0 and "留下" in capsys.readouterr().out
    with closing(sqlite3.connect(board)) as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == 2
        assert con.execute("SELECT count(*) FROM kr_readings").fetchone()[0] == 0
    backups = list((board.parent / "backups").glob("nawaban-*.db"))
    assert backups
    with closing(sqlite3.connect(backups[0])) as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == 1
        assert con.execute("SELECT title FROM tasks").fetchall() == [("留下",)]


def test_init_on_an_old_board_migrates_it(board):
    with closing(sqlite3.connect(board)) as con:
        con.executescript("DROP TABLE kr_readings; DROP TABLE okr_accepts; PRAGMA user_version=1;")
    assert cli.main(["--db", str(board), "init"]) == 0
    assert rows(board) == []


def test_okr_keeps_each_reading_once_and_skips_failed_and_untested(repo, board, capsys):
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert "读数新记 2 条" in capsys.readouterr().out
    got = {(r[0], r[1], r[2], r[3], r[4]) for r in rows(board)}
    assert got == {(str(repo.resolve()), "意图准确率", 100.0, "2026-11-17", ""),
                   (str(repo.resolve()), "L1 首位", 89.0, "2026-11-17", "")}
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert "读数新记 0 条" in capsys.readouterr().out and len(rows(board)) == 2


def test_as_of_is_the_date_and_source_the_rest(repo, board):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = "echo 3 2026-11-18 a/b.md"\n')
    cli.main(["--db", str(board), "okr"])
    assert [r[3:5] for r in rows(board)] == [("2026-11-18", "a/b.md")]


def test_okr_in_a_worktree_records_under_the_main_checkout(repo, board, monkeypatch):
    wt = repo.parent / "wt"
    subprocess.run(["git", "worktree", "add", "-q", str(wt)], cwd=repo, check=True)
    monkeypatch.chdir(wt)
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert {r[0] for r in rows(board)} == {str(repo.resolve())}


def test_okr_without_a_board_prints_and_records_nothing(repo, capsys):
    code, out = okr(capsys)
    assert code == 0 and "没有看板" in out


# KR names → readings (value, as_of), oldest first
def seed(db, repo, readings, at="2026-11-19T00:00:00"):
    with closing(sqlite3.connect(db)) as con, con:
        for kr, rs in readings.items():
            for i, (v, as_of) in enumerate(rs):
                con.execute("INSERT INTO kr_readings VALUES (?, ?, ?, ?, '', ?)",
                            (str(repo.resolve()), kr, v, as_of, f"{at[:-2]}{i:02d}"))


def jokr(db, capsys, *extra):
    capsys.readouterr()
    code = cli.main(["--db", str(db), "json", "okr", *extra])
    return code, json.loads(capsys.readouterr().out)


def define(repo, krs):
    body = '[[objective]]\nname = "O"\n' + "".join(f'[[objective.kr]]\nname = "{n}"\ntarget = "{t}"\n{x}\n'
                                               for n, t, x in krs)
    (repo / "docs" / "agents" / "okr.toml").write_text(body)


def kinds(data):
    return {(a["kind"], a["kr"]) for a in data["attention"]}


def test_json_okr_reads_the_board_and_never_runs_a_measure(repo, board, capsys, monkeypatch):
    monkeypatch.setattr(cli, "_measure", lambda *a: (_ for _ in ()).throw(AssertionError("ran a measure")))
    seed(board, repo, {"意图准确率": [(90, "2026-11-10"), (97.5, "2026-11-18")]})
    code, data = jokr(board, capsys)
    assert code == 0 and data["repo"] == str(repo.resolve()) and data["def_commit"]
    o = data["objectives"][0]
    k = o["krs"][0]
    assert (k["status"], k["value"], k["as_of"], k["trend"], k["missed_rounds"]) == ("met", 97.5, "2026-11-18", "closer", 0)
    assert k["history"] == [{"value": 90, "as_of": "2026-11-10"}, {"value": 97.5, "as_of": "2026-11-18"}]
    assert {x["name"]: x["status"] for x in o["krs"]}["边界难例"] == "untested"
    assert (data["met"], data["total"], o["met"], o["total"]) == (1, 6, 1, 3)


def test_json_okr_with_repo_and_no_okr_file_is_a_json_error(board, tmp_path, capsys):
    subprocess.run(["git", "init", "-q", str(tmp_path / "bare")], check=True)
    code, data = jokr(board, capsys, "--repo", str(tmp_path / "bare"))
    assert code == 1 and "okr.toml" in data["error"]


@pytest.mark.parametrize("target,values,trend", [
    (">= 95", [80, 85], "closer"), (">= 95", [85, 80], "away"), (">= 95", [80, 80], "flat"),
    ("<= 5", [9, 7], "closer"), ("<= 5", [7, 9], "away"),
    ("== 0", [-3, 2], "closer"), ("== 0", [2, -3], "away"), ("== 0", [2, -2], "flat")])
def test_closer_is_toward_the_target(repo, board, capsys, target, values, trend):
    define(repo, [("K", target, "")])
    seed(board, repo, {"K": [(v, f"2026-11-1{i}") for i, v in enumerate(values)]})
    assert jokr(board, capsys)[1]["objectives"][0]["krs"][0]["trend"] == trend


def test_stuck_is_missed_with_two_rounds_not_closer(repo, board, capsys):
    define(repo, [("卡住", ">= 95", ""), ("在动", ">= 95", ""), ("两条", ">= 95", ""), ("达标", ">= 95", "")])
    seed(board, repo, {"卡住": [(80, "2026-11-10"), (80, "2026-11-11"), (79, "2026-11-12")],
                       "在动": [(80, "2026-11-10"), (80, "2026-11-11"), (81, "2026-11-12")],
                       "两条": [(80, "2026-11-10"), (80, "2026-11-11")],
                       "达标": [(96, "2026-11-10"), (96, "2026-11-11"), (96, "2026-11-12")]})
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("stuck", "卡住")}
    assert "80、80、79" in data["attention"][0]["text"]


def test_five_is_five_missed_rounds_in_a_row(repo, board, capsys):
    define(repo, [("五轮", ">= 95", ""), ("四轮", ">= 95", "")])
    seed(board, repo, {"五轮": [(96, "2026-11-09")] + [(80 + i, f"2026-11-1{i}") for i in range(5)],
                       "四轮": [(96, "2026-11-09")] + [(80 + i, f"2026-11-1{i}") for i in range(4)]})
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("five", "五轮")}
    assert {k["name"]: k["missed_rounds"] for k in data["objectives"][0]["krs"]} == {"五轮": 5, "四轮": 4}


def test_five_still_shows_once_the_latest_reading_has_gone_stale(repo, board, capsys):
    define(repo, [("K", ">= 95", "max_age_days = 7")])
    seed(board, repo, {"K": [(80 + i, f"2020-01-1{i}") for i in range(5)]})
    data = jokr(board, capsys)[1]
    assert data["objectives"][0]["krs"][0]["status"] == "stale" and kinds(data) == {("five", "K")}


def test_wait_is_a_kr_waiting_on_the_decision_maker_without_a_measure(repo, board, capsys):
    define(repo, [("要批", ">= 1", 'wait = "批读生产数据"'), ("有量", ">= 1", 'wait = "x"\nmeasure = "echo 1 2026-11-18"')])
    data = jokr(board, capsys)[1]
    assert data["attention"] == [{"kind": "wait", "objective": "O", "kr": "要批", "text": "批读生产数据"}]
    assert data["objectives"][0]["krs"][0]["wait"] == "批读生产数据"


def test_a_non_string_wait_refuses_the_file(repo, board, capsys):
    define(repo, [("K", ">= 1", "wait = 3")])
    code, data = jokr(board, capsys)
    assert code == 1 and "wait" in data["error"]


def accepted(db, repo, at):
    with closing(sqlite3.connect(db)) as con, con:
        con.execute("INSERT INTO okr_accepts VALUES (?, 'O', ?)", (str(repo.resolve()), at))


def test_accept_is_asked_when_all_met_and_never_accepted_or_missed_since(repo, board, capsys):
    define(repo, [("K", ">= 1", "")])
    seed(board, repo, {"K": [(2, "2026-11-10")]}, at="2026-11-10T00:00:00")
    assert kinds(jokr(board, capsys)[1]) == {("accept", None)}
    accepted(board, repo, "2026-11-11T00:00:00")
    data = jokr(board, capsys)[1]
    assert data["attention"] == [] and data["objectives"][0]["accept_pending"] is False
    seed(board, repo, {"K": [(0, "2026-11-12"), (3, "2026-11-13")]}, at="2026-11-12T00:00:00")
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("accept", None)} and data["objectives"][0]["accept_pending"] is True


def test_accept_is_not_asked_while_a_kr_is_not_met(repo, board, capsys):
    define(repo, [("K", ">= 1", ""), ("J", ">= 1", "")])
    seed(board, repo, {"K": [(2, "2026-11-10")]})
    assert jokr(board, capsys)[1]["attention"] == []


def test_okr_accept_refuses_unless_the_objective_is_all_met_now(repo, board, capsys):
    assert cli.main(["--db", str(board), "okr", "--accept", "听得懂需求"]) == 1
    assert "还没全 ✓" in capsys.readouterr().err and rows(board, "okr_accepts") == []
    assert cli.main(["--db", str(board), "okr", "--accept", "没这个"]) == 1
    define(repo, [("K", ">= 1", 'measure = "echo 2 2026-11-18"')])
    assert cli.main(["--db", str(board), "okr", "--accept", "O"]) == 0
    assert [r[:2] for r in rows(board, "okr_accepts")] == [(str(repo.resolve()), "O")]
