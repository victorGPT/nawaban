#!/usr/bin/env python3
"""标题写侧闸 + retitle 留痕(2026-09-07 · PM 看板看不懂卡是干嘛的)。

判据验能力不验快照:自己造局。
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "nawaban"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from nawaban import db  # noqa: E402
from nawaban.task_content import title_problem  # noqa: E402

FAILED = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except AssertionError as e:
        FAILED.append(name)
        print(f"  ✗ {name}: {e}")


REJECT = {
    "反引号": "TG 报 bug → `/ai` → pi 只读分析",
    "snake_case": "并发跑同月两张源表时 ensure_folder 会建出两个同名文件夹",
    "全大写 flag": "CI_HEAVY_RUNNER 开着第 3 天",
    "文件名": "迁移 084/086 活导入 capabilities.py",
    "路径": "摘掉 /api/iam/me 里恒真的字段",
    "分句": "示例目录的三个入口缺少检查 · 靠代理挡着 · 页面因此不可用",
}
PASS = [
    "会议纪要 tab 变成一张卡,只有一个权限的人只见一个按钮",
    "HR 一步登记完成,不再挂着等部门主管批",
    "强制下线后,人在所有 SSO 接入系统都真的下线",
    "bot 拒绝文案区分「中台没这个人」与「有档案但没发过 /start」",
    "员工姓名/部门/岗位手改后不再被同步冲掉,可解锁",
    "报销源表每月删两个月前的 xlsx,凭证图一张不动",
]


def main() -> int:
    print("TITLE GATE 判据验证\n")
    def reject(t: str, why: str):
        err = title_problem(t)
        assert err is not None, "放过了"
        assert why.split()[0] in err, f"原因没点名:{err[:60]}"
        assert "示范" in err, "报错缺示范"

    def allow(t: str):
        assert title_problem(t) is None, title_problem(t)[:80]

    for why, t in REJECT.items():
        case(f"拒:{why}", lambda t=t, why=why: reject(t, why))
    for t in PASS:
        case(f"过:{t[:18]}", lambda t=t: allow(t))

    def t_retitle():
        p = Path(tempfile.mkdtemp(prefix="retitle-")) / "workos.db"
        db.init_db(p)
        db.create_task(p, task_id="T-001", title="旧标题", context="x")
        old = db.retitle(p, "T-001", title="新标题", author="ac:test")
        assert old == "旧标题", old
        con = sqlite3.connect(p)
        title, = con.execute("select title from tasks where id='T-001'").fetchone()
        assert title == "新标题", title
        body, = con.execute("select body from task_events where task_id='T-001' and kind='note'").fetchone()
        assert "旧标题" in body, body
        try:
            db.retitle(p, "T-001", title="新标题", author="ac:test")
            raise AssertionError("同名应拒")
        except db.NawabanError:
            pass

    case("retitle 改标题 + 旧标题进 note", t_retitle)
    print(f"\n{'FAILED: ' + ', '.join(FAILED) if FAILED else 'ALL PASS'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
