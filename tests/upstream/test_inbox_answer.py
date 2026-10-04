#!/usr/bin/env python3
"""workos inbox write regression 回归自检 · 零依赖。

选型 B(板只读,写走 cli 子进程)后,写路径全部落在 cli —— 所以测试直接驱动 cli,
跑的就是板将来 fork 的那条命令。

覆盖(对照卡 success):
  happy    回答 accept → 卡 done 且 task_decisions 多一行
  扇出     authorize 回答后卡**不动**(授权≠已生效);fanout --ok 才关卡
  错误处理 fanout --failed 一张都不关;未 answer 就 fanout 被拒
  并发     两窗口答同一 ask,第二个拿明确报错而非静默覆盖
  打回     accept --reject → 卡退回 in_progress 返工
"""
from __future__ import annotations

import os
import subprocess
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str((Path(__file__).resolve().parents[2]) / "workos"))
sys.path.insert(0, str((Path(__file__).resolve().parents[2])))

from nawaban import db  # noqa: E402

CLI = str((Path(__file__).resolve().parents[2]) / "nawaban" / "cli.py")
FAILED: list[str] = []


def cli(dbp: Path, *args: str) -> tuple[int, str]:
    env = dict(os.environ, NAWABAN_OWNER="ac:test", CLAUDE_SESSION_ID="s-test")
    env.pop("NAWABAN_DECISION_CHANNEL", None)   # 确保测的是 answer 自己开的通道
    p = subprocess.run([sys.executable, CLI, "--db", str(dbp), *args],
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except AssertionError as e:
        FAILED.append(name)
        print(f"  ✗ {name}: {e}")


def mkcard(p: Path, tid: str) -> None:
    """造一张 in_progress 的卡(带 acceptance_run,否则过不了 done 闸①)。

    翻 staging-verified 交给 settle() —— decision 闸要求翻牌时已挂一条未关的 ask,
    所以顺序固定是 mkcard → raise_ask → settle,与真实流程一致(先提得出问题,再翻牌等人答)。
    """
    db.create_task(p, task_id=tid, title=f"{tid} 卡", context="answer 自检")
    db.claim_task(p, tid, owner="ac:test", session_id="s-seed")
    db.start_task(p, tid, owner="ac:test", session_id="s-seed")
    db.add_ref(p, tid, kind="acceptance_run", value="真机实测 run 1")


def settle(p: Path, *tids: str, wait: bool = False, align: bool = False) -> None:
    """把卡翻到 staging-verified/decision(调用方须已提过挂这些卡的 ask)。

    align=True 先对齐到下一秒开头再翻牌 —— 要验「同秒自批被拦」就得**真的**同秒,
    而 answer 走子进程要几百毫秒,随机落在秒边界哪一侧,不对齐时约五分之一的跑法
    会跨秒、闸放行、用例假红。靠运气的断言不是断言。

    wait=True 时多等一秒:done 闸② 要求拍板行**严格晚于**翻 staging-verified 的那一秒
    (created_at 是秒级整数,同秒分不清先后,而同秒恰是 agent 机器速度自批的特征)。
    要验「卡能被归档」就得让时间真的走过去 —— 这不是绕过闸,是把测试放进真实时序。
    """
    if align:
        import time
        time.sleep(1.0 - time.time() % 1.0)
    for tid in tids:
        db.advance_task(p, tid, to="staging-verified", waiting_on="decision",
                        owner="ac:test", session_id="s-seed")
    if wait:
        import time
        time.sleep(1.05)


def status(p: Path, tid: str) -> str:
    return sqlite3.connect(p).execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0]


def n_decisions(p: Path, tid: str) -> int:
    return sqlite3.connect(p).execute(
        "SELECT count(*) FROM task_decisions WHERE task_id=?", (tid,)).fetchone()[0]


def fresh(tmp: Path, name: str) -> Path:
    p = tmp / f"{name}.db"
    db.init_db(p)
    return p


def main() -> int:  # noqa: C901
    tmp = Path(tempfile.mkdtemp(prefix="answer-"))
    print(f"Inbox answer self-test · {tmp}\n")

    def t_accept_closes_card():
        p = fresh(tmp, "acc")
        mkcard(p, "T-A-001")
        aid = db.raise_ask(p, kind="accept", question="收下吗?", evidence="真机实测",
                           task_ids=["T-A-001"], raised_by="agent")
        settle(p, "T-A-001", wait=True)
        before = n_decisions(p, "T-A-001")
        code, out = cli(p, "answer", str(aid), "--verdict", "收下")
        assert code == 0, out
        assert status(p, "T-A-001") == "done", f"卡未归档:{status(p,'T-A-001')}\n{out}"
        assert n_decisions(p, "T-A-001") == before + 1, "task_decisions 未 +1"
        assert db.open_asks(p) == [], "ask 未关闭"

    def t_accept_reject_returns_card():
        p = fresh(tmp, "rej")
        mkcard(p, "T-R-001")
        aid = db.raise_ask(p, kind="accept", question="收下吗?", evidence="真机实测",
                           task_ids=["T-R-001"], raised_by="agent")
        settle(p, "T-R-001")
        code, out = cli(p, "answer", str(aid), "--verdict", "不行,回去改", "--reject")
        assert code == 0, out
        assert status(p, "T-R-001") == "in_progress", f"打回未回 in_progress\n{out}"

    def t_authorize_does_not_touch_cards():
        """授权 ≠ 已生效:回答只写决策,卡一张不动。"""
        p = fresh(tmp, "auth")
        for t in ("T-P-001", "T-P-002"):
            mkcard(p, t)
        aid = db.raise_ask(p, kind="authorize", question="要上线吗?", evidence="真机实测",
                           task_ids=["T-P-001", "T-P-002"], raised_by="agent",
                           blast={"who": "x", "what": "y", "rollback": "z"})
        settle(p, "T-P-001", "T-P-002")
        code, out = cli(p, "answer", str(aid), "--verdict", "授权部署")
        assert code == 0, out
        assert all(status(p, t) == "staging-verified" for t in ("T-P-001", "T-P-002")), \
            "authorize 回答后卡不该动"
        assert "未动" in out and "fanout" in out, f"应提示扇出待动作成功:\n{out}"

    def t_fanout_ok_closes_all():
        """成功后扇出:ask 挂的卡全部关(flag 分流随 flag 列退役 · foreman simplify regression)。"""
        p = fresh(tmp, "fan")
        mkcard(p, "T-F-A")
        mkcard(p, "T-F-B")
        aid = db.raise_ask(p, kind="authorize", question="要上线吗?", evidence="真机实测",
                           task_ids=["T-F-A", "T-F-B"],
                           raised_by="agent", blast={"who": "x", "what": "y", "rollback": "z"})
        settle(p, "T-F-A", "T-F-B", wait=True)
        cli(p, "answer", str(aid), "--verdict", "授权部署")
        code, out = cli(p, "fanout", str(aid), "--ok")
        assert code == 0, out
        assert status(p, "T-F-A") == "done" and status(p, "T-F-B") == "done", out

    def t_fanout_failed_closes_nothing():
        p = fresh(tmp, "fail")
        mkcard(p, "T-X-001")
        aid = db.raise_ask(p, kind="authorize", question="要上线吗?", evidence="真机实测",
                           task_ids=["T-X-001"], raised_by="agent",
                           blast={"who": "x", "what": "y", "rollback": "z"})
        settle(p, "T-X-001")
        cli(p, "answer", str(aid), "--verdict", "授权部署")
        code, out = cli(p, "fanout", str(aid), "--failed")
        assert code == 0, out
        assert status(p, "T-X-001") == "staging-verified", f"失败时一张都不该关\n{out}"

    def t_fanout_before_answer_rejected():
        p = fresh(tmp, "early")
        mkcard(p, "T-E-001")
        aid = db.raise_ask(p, kind="authorize", question="要上线吗?", evidence="真机实测",
                           task_ids=["T-E-001"], raised_by="agent",
                           blast={"who": "x", "what": "y", "rollback": "z"})
        settle(p, "T-E-001")
        code, out = cli(p, "fanout", str(aid), "--ok")
        assert code != 0, f"未 answer 就 fanout 应被拒\n{out}"

    def t_double_answer_loud():
        """并发:第二个回答必须拿明确报错,不能静默覆盖。"""
        p = fresh(tmp, "dup")
        mkcard(p, "T-D-001")
        aid = db.raise_ask(p, kind="accept", question="收下吗?", evidence="真机实测",
                           task_ids=["T-D-001"], raised_by="agent")
        # 第一次回答必须真的成功,才谈得上第二次被拒
        settle(p, "T-D-001", wait=True)
        c1, _ = cli(p, "answer", str(aid), "--verdict", "收下")
        assert c1 == 0
        c2, out = cli(p, "answer", str(aid), "--verdict", "我也收下")
        assert c2 != 0, "重复回答必须失败"
        assert "已于早前关闭" in out, out

    def t_user_channel_is_inbox():
        """决策来源可审计:收件箱回答记 decided_by=user,且不需要外部设 channel。"""
        p = fresh(tmp, "chan")
        mkcard(p, "T-C-001")
        aid = db.raise_ask(p, kind="accept", question="收下吗?", evidence="真机实测",
                           task_ids=["T-C-001"], raised_by="agent")
        settle(p, "T-C-001", wait=True)
        cli(p, "answer", str(aid), "--verdict", "收下")
        by = sqlite3.connect(p).execute(
            "SELECT decided_by FROM task_decisions WHERE task_id='T-C-001'"
            " ORDER BY id DESC LIMIT 1").fetchone()[0]
        assert by == "user", f"decided_by 应为 user,实为 {by}"

    def t_same_second_blocked_and_retryable():
        """同秒回答被 done 闸② 拦住(那是它的设计意图):此时 ask 必须**仍开着**,可重试。

        这条守的是 answer 的顺序不变量 —— 先扇出再关 ask。反过来就会留下
        「决策写了、ask 关了、卡没关」的不可重试状态。
        """
        p = fresh(tmp, "samesec")
        mkcard(p, "T-S-001")
        aid = db.raise_ask(p, kind="accept", question="收下吗?", evidence="真机实测",
                           task_ids=["T-S-001"], raised_by="agent")
        settle(p, "T-S-001", align=True)          # 不 wait:回答与翻牌落在同一秒
        code, out = cli(p, "answer", str(aid), "--verdict", "收下")
        assert code != 0, f"同秒自批应被 done 闸② 拦住\n{out}"
        assert status(p, "T-S-001") == "staging-verified", "卡不该动"
        assert len(db.open_asks(p)) == 1, f"闸拦住时 ask 必须仍开着可重试\n{out}"

    def t_decision_needs_ask_first():
        """入口闸:翻 verified 且等人拍板,必须先挂一条未关的 ask。

        没有它,卡等的是一个永远问不出口的问题 —— done 闸② 只认 ask→answer 通道
        落的运行时拍板行,而人从没在收件箱见过这张卡。出口设死闸、入口不设 = 永久沉底。
        """
        p = fresh(tmp, "askgate")
        mkcard(p, "T-G-001")
        try:
            settle(p, "T-G-001")
        except db.NawabanError as e:
            assert "decision 闸" in str(e), e
        else:
            raise AssertionError("无 ask 就翻 decision 应被拒")
        assert status(p, "T-G-001") == "in_progress", "被拒时卡不该动"

        # 其他 waiting_on 不受牵连(prod/observe/external 不走拍板通道)
        mkcard(p, "T-G-002")
        db.advance_task(p, "T-G-002", to="staging-verified", waiting_on="prod",
                        owner="ac:test", session_id="s-seed")
        assert status(p, "T-G-002") == "staging-verified", "prod 卡不该被 decision 闸挡"

        # 提了 ask 就放行;ask 已关闭的不算数(等于没人在问)
        db.raise_ask(p, kind="accept", question="收下吗?", evidence="真机实测",
                     task_ids=["T-G-001"], raised_by="agent")
        settle(p, "T-G-001")
        assert status(p, "T-G-001") == "staging-verified", "有未关 ask 应放行"

    cases = [
        ("入口闸:无 ask 不得翻 decision(防永久沉底)", t_decision_needs_ask_first),
        ("accept 回答 → 卡归档 + 决策 +1", t_accept_closes_card),
        ("同秒自批被闸拦 + ask 仍可重试", t_same_second_blocked_and_retryable),
        ("accept 打回 → 卡退回 in_progress", t_accept_reject_returns_card),
        ("authorize 回答后卡一张不动(授权≠已生效)", t_authorize_does_not_touch_cards),
        ("fanout --ok 关全部挂卡", t_fanout_ok_closes_all),
        ("fanout --failed 一张都不关", t_fanout_failed_closes_nothing),
        ("未 answer 就 fanout 被拒", t_fanout_before_answer_rejected),
        ("并发:重复回答拿明确报错", t_double_answer_loud),
        ("决策来源 decided_by=user(inbox 通道)", t_user_channel_is_inbox),
    ]
    for name, fn in cases:
        case(name, fn)

    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print(f"\nOK · {len(cases)}/{len(cases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
