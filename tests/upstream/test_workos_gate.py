#!/usr/bin/env python3
"""workos compile gate regression 回归自检 · 零依赖(不需 pytest)。

跑法:python3 tests/upstream/test_workos_gate.py → 全绿 OK / 任一失败 exit 1。
闸走**真进程**(subprocess 喂 stdin JSON),不是 import 后调函数——Stop hook 的真实调用形态。
预算状态文件靠 TMPDIR 重定向做用例隔离(闸用 tempfile.gettempdir())。

覆盖(对照卡 success):
  ② 三件套缺失→顶回 · ≤2 预算 · 第三次放行且记违规(只记一次)· 排除 status_change 的暗雷
  ③ 保存闸(artifact 不存在→拒收尾)· 三件套原子(now 缺失→零写入)
  极性:fail-open 四路(无库/无 .foreman/坏 stdin/无 session_id)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db  # noqa: E402

GATE = FOREMAN / "nawaban" / "compile_gate.py"
CLI = FOREMAN / "nawaban" / "cli.py"

FAILED: list[str] = []
SID = "sess-under-test"


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def fresh(tmp: Path, name: str = "workos.db") -> Path:
    p = tmp / name
    if p.exists():
        p.unlink()
    db.init_db(p)
    return p


def claimed(tmp: Path, tid: str = "T-GATE-001") -> Path:
    """建卡 + claim(此时卡上只有 claim 自带的 status_change 事件)。"""
    p = fresh(tmp)
    db.create_task(p, task_id=tid, title="编译闸测试卡:收尾没写回就被顶回", context="测试")
    assert db.claim_task(p, tid, owner="w1", session_id=SID)
    return p


def run_gate(payload: dict, *, db_path: Path | None, state_dir: Path,
             raw: str | None = None) -> tuple[int, dict | None, str]:
    """→ (exit_code, 顶回 JSON or None, stderr)。"""
    env = {**os.environ, "TMPDIR": str(state_dir)}
    env.pop("NAWABAN_DB", None)
    if db_path is not None:
        env["NAWABAN_DB"] = str(db_path)
    r = subprocess.run(
        [sys.executable, str(GATE)],
        input=json.dumps(payload) if raw is None else raw,
        capture_output=True, text=True, env=env,
    )
    out = json.loads(r.stdout) if r.stdout.strip() else None
    return r.returncode, out, r.stderr


def stop_payload(cwd: str = "/tmp", sid: str = SID) -> dict:
    return {"session_id": sid, "cwd": cwd, "hook_event_name": "Stop",
            "stop_hook_active": False, "last_assistant_message": "干完了(纯文本)"}


def state_dir(tmp: Path, tag: str) -> Path:
    d = tmp / f"state-{tag}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-gate-test-"))
    print(f"[编译闸自检] tmp={tmp}")

    # ── 1 · 放行:本 session 无未收尾 claim ────────────────────────
    def t_no_claim():
        p = fresh(tmp)
        db.create_task(p, task_id="T-GATE-001", title="没人认领的卡", context="测试")
        code, out, _ = run_gate(stop_payload(), db_path=p, state_dir=state_dir(tmp, "1"))
        assert code == 0 and out is None, f"无 claim 不该顶回:{out}"

    # ── 2 · 暗雷回归:claim 自带 status_change 不算「干过活」 ──────
    def t_status_change_not_substantive():
        p = claimed(tmp)
        con = db.connect(p)
        n = con.execute("SELECT count(*) FROM task_events WHERE session_id=?", (SID,)).fetchone()[0]
        con.close()
        assert n == 1, "前提变了:claim 应自带 1 条 status_change"
        code, out, _ = run_gate(stop_payload(), db_path=p, state_dir=state_dir(tmp, "2"))
        assert code == 0 and out is None, "只有 status_change 就顶回 = 预算会在开工第一轮烧光"

    # ── 3 · 顶回:有实质事件却没收尾 ──────────────────────────────
    def t_nudge_on_substantive_work():
        p = claimed(tmp)
        db.add_event(p, "T-GATE-001", kind="note", body="改了 3 个文件", author="w1", session_id=SID)
        code, out, _ = run_gate(stop_payload(), db_path=p, state_dir=state_dir(tmp, "3"))
        assert code == 0, "闸永远 exit 0(顶回走 stdout JSON)"
        assert out and out["decision"] == "block", f"该顶回却放行:{out}"
        r = out["reason"]
        assert "T-GATE-001" in r, "顶回文案必须点名卡号"
        assert "handoff" in r and "--now" in r, "顶回文案必须给出补法(卡 constraint:只说缺什么怎么补)"
        assert len(r) <= 500, f"顶回文案 {len(r)} 字 > 500(卡 constraint)"

    # ── 4 · 预算 ≤2:第三次放行 + 记违规事件(只记一次)──────────
    def t_budget_two_then_violation():
        p = claimed(tmp)
        db.add_event(p, "T-GATE-001", kind="note", body="干了活", author="w1", session_id=SID)
        sd = state_dir(tmp, "4")
        for i in (1, 2):
            _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=sd)
            assert out and out["decision"] == "block", f"第 {i} 次该顶回:{out}"
        for i in (3, 4):
            _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=sd)
            assert out is None, f"预算耗尽第 {i} 次必须放行(卡 constraint:不死磕)"
        con = db.connect(p)
        rows = con.execute(
            "SELECT author, body FROM task_events WHERE kind='note' AND body LIKE '⚠️ 编译闸违规%'"
        ).fetchall()
        con.close()
        assert len(rows) == 1, f"违规事件必须恰好一条(不许每轮刷屏),实得 {len(rows)}"
        assert rows[0][0] == "nawaban-gate", "违规是闸判的,author 不许用 worker 身份"

    # ── 4b · 违规写入撞锁不许挂死(constraint:卡死 session 比漏编译更糟)──
    def t_violation_write_never_hangs():
        p = claimed(tmp)
        db.add_event(p, "T-GATE-001", kind="note", body="干了活", author="w1", session_id=SID)
        sd = state_dir(tmp, "4b")
        for _ in (1, 2):
            run_gate(stop_payload(), db_path=p, state_dir=sd)
        lock = db.connect(p)              # 模拟并发写者(阿搬导入 / guard)持写锁
        lock.execute("BEGIN IMMEDIATE")
        t0 = time.time()
        _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=sd)
        dt = time.time() - t0
        lock.execute("ROLLBACK")
        lock.close()
        assert out is None, "撞锁时必须放行"
        assert dt < 10, f"撞锁挂了 {dt:.1f}s —— busy_timeout 没吃到 200ms(默认 30s 会挂死 session)"
        _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=sd)
        assert out is None, "flagged 已落盘,不许再顶回"
        con = db.connect(p)
        n = con.execute("SELECT count(*) FROM task_events WHERE body LIKE '⚠️ 编译闸违规%'").fetchone()[0]
        con.close()
        assert n == 0, "先落盘后写库:违规记录可丢(fail-open),但绝不许事后补写重试"

    # ── 4c · 多卡顶回文案仍 ≤500 字 ───────────────────────────────
    def t_nudge_text_capped():
        p = fresh(tmp)
        for i in range(6):
            tid = f"T-MANY-{i:03d}"
            db.create_task(p, task_id=tid, title=f"多卡文案上限测试 {i}", context="测试")
            db.claim_task(p, tid, owner="w1", session_id=SID)
            db.add_event(p, tid, kind="note", body="干了活", author="w1", session_id=SID)
        _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=state_dir(tmp, "4c"))
        assert out and len(out["reason"]) <= 500, f"6 张卡时文案 {len(out['reason'])} 字 > 500"

    # ── 5 · 收尾后放行 ────────────────────────────────────────────
    def t_pass_after_handoff():
        p = claimed(tmp)
        db.add_event(p, "T-GATE-001", kind="note", body="干了活", author="w1", session_id=SID)
        sd = state_dir(tmp, "5")
        _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=sd)
        assert out and out["decision"] == "block", "前提:收尾前应顶回"
        db.handoff(p, "T-GATE-001", owner="w1", session_id=SID, outcome="handed_off",
                   summary="做完 spike", now="进行中:闸主体已建,剩真机全链")
        _, out, _ = run_gate(stop_payload(), db_path=p, state_dir=sd)
        assert out is None, "交齐三件套后必须放行"

    # ── 6 · 三件套原子:now 缺失 → 整笔拒(零写入)─────────────────
    def t_now_required_atomic():
        for bad in (None, "", "   "):
            p = claimed(tmp)
            try:
                db.handoff(p, "T-GATE-001", owner="w1", session_id=SID,
                           outcome="completed", summary="偷偷不写 now", now=bad)
            except db.NawabanError:
                pass
            else:
                raise AssertionError(f"now={bad!r} 未被拒")
            con = db.connect(p)
            ended = con.execute("SELECT ended_at FROM task_sessions WHERE session_id=?",
                                (SID,)).fetchone()[0]
            ev = con.execute("SELECT count(*) FROM task_events WHERE kind='handoff'").fetchone()[0]
            con.close()
            assert ended is None and ev == 0, "拒收尾必须零写入(三件套原子,不落半套)"

    # ── 7 · 保存闸走 CLI 真路径:artifact 不存在 → 拒收尾 ──────────
    def t_artifact_gate_via_cli():
        p = claimed(tmp)
        env = {**os.environ, "NAWABAN_DB": str(p), "CLAUDE_CODE_SESSION_ID": SID,
               "NAWABAN_OWNER": "w1"}
        # handoff 闸:completed 须先翻牌;保存闸与 outcome 无关,用 handed_off
        base = [sys.executable, str(CLI), "handoff", "T-GATE-001", "--outcome", "handed_off",
                "--summary", "收工", "--now", "已收尾"]
        r = subprocess.run(base + ["--artifact", str(tmp / "查无此文件.md")],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 1 and "保存闸" in r.stderr, f"artifact 缺失未拒:{r.stderr}"
        art = tmp / "真产出.md"
        art.write_text("ok", encoding="utf-8")
        r = subprocess.run(base + ["--artifact", str(art)],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, f"artifact 存在却被拒:{r.stderr}"
        # CLI 层 --now 必填(政策层早失败,给人话报错)
        r = subprocess.run([sys.executable, str(CLI), "handoff", "T-GATE-001", "--outcome",
                            "completed", "--summary", "x"], capture_output=True, text=True, env=env)
        assert r.returncode != 0 and "--now" in r.stderr, "CLI 未把 --now 设为必填"

    # ── 8 · fail-open 四路(极性与 guard 相反)─────────────────────
    def t_fail_open():
        sd = state_dir(tmp, "8")
        code, out, _ = run_gate(stop_payload(), db_path=tmp / "查无此库.db", state_dir=sd)
        assert code == 0 and out is None, "库不存在必须放行"
        code, out, _ = run_gate({"cwd": "/tmp", "hook_event_name": "Stop"}, db_path=None,
                                state_dir=sd)
        assert code == 0 and out is None, "无 session_id 必须放行"
        code, out, _ = run_gate({}, db_path=None, state_dir=sd, raw="这不是 JSON{{")
        assert code == 0 and out is None, "stdin 坏掉必须放行"
        code, out, _ = run_gate(stop_payload(cwd=str(tmp / "无板目录")), db_path=None,
                                state_dir=sd)
        assert code == 0 and out is None, "cwd 上溯找不到 .foreman 必须放行"

    # ── 9 · 库定位:无 NAWABAN_DB 时从 stdin.cwd 上溯 .foreman/ ─────
    def t_resolve_from_cwd():
        repo = tmp / "repo"
        (repo / ".foreman").mkdir(parents=True, exist_ok=True)
        sub = repo / "deep"
        sub.mkdir(parents=True, exist_ok=True)
        p = repo / ".foreman" / "workos.db"
        if p.exists():
            p.unlink()
        db.init_db(p)
        db.create_task(p, task_id="T-GATE-002", title="上溯定位测试卡", context="测试")
        db.claim_task(p, "T-GATE-002", owner="w1", session_id=SID)
        db.add_event(p, "T-GATE-002", kind="note", body="干了活", author="w1", session_id=SID)
        _, out, _ = run_gate(stop_payload(cwd=str(sub)), db_path=None,
                             state_dir=state_dir(tmp, "9"))
        assert out and "T-GATE-002" in out["reason"], f"未从 cwd 上溯到板:{out}"

    # ── 10 · done 闸②「无锚点 fail-closed」(总监 2026-08-12 派活)──
    def sv_card_no_anchor(p: Path, tid: str, *, hist_user: bool) -> None:
        """导入一张 staging-verified 卡:**无** →staging-verified 锚点事件(旧 md 从没写过
        staging_verified_at 的那 22 张的形状)。hist_user=历史 user 拍板行(必带 provenance)。"""
        db.import_task(
            p, task_id=tid, title="无锚点历史卡:等拍板", status="staging-verified",
            waiting_on="decision", created_at=1000,
            refs=[{"kind": "acceptance_run", "value": "旧卡 acceptance 原文", "created_at": 1000}],
            decisions=([{"question": "上不上", "verdict": "上", "decided_by": "user",
                         "created_at": 1500,
                         "provenance": {"source": "import", "file": f"{tid}.md", "line": 9,
                                        "raw": "acceptance: 用户已确认"}}]
                       if hist_user else []),
        )

    def t_gate2_no_anchor_rejects_historical_user_row():
        p = fresh(tmp)
        sv_card_no_anchor(p, "T-NOANCHOR-001", hist_user=True)
        try:
            db.advance_task(p, "T-NOANCHOR-001", to="done", owner="w1", session_id=SID)
        except db.NawabanError as e:
            assert "锚点事件" in str(e) and "历史导入" in str(e), f"拒了但不是无锚点闸:{e}"
        else:
            raise AssertionError("无锚点卡靠历史导入的 user 行就批成 done = 静默自批(架空面)")
        con = db.connect(p)
        st = con.execute("SELECT status FROM tasks WHERE id='T-NOANCHOR-001'").fetchone()[0]
        con.close()
        assert st == "staging-verified", "拒 done 后状态不许动"

    def t_gate2_no_anchor_accepts_runtime_verdict():
        """fail-closed 不等于死锁:现落一条真人拍板(provenance IS NULL)必须能放行。"""
        p = fresh(tmp)
        sv_card_no_anchor(p, "T-NOANCHOR-002", hist_user=True)
        os.environ["NAWABAN_DECISION_CHANNEL"] = "chat"
        try:
            db.decide(p, "T-NOANCHOR-002", question="现在能 done 吗",
                      verdict="用户原话:done 了", decided_by="user")
        finally:
            os.environ.pop("NAWABAN_DECISION_CHANNEL", None)
        db.advance_task(p, "T-NOANCHOR-002", to="done", owner="w1", session_id=SID)
        con = db.connect(p)
        st = con.execute("SELECT status FROM tasks WHERE id='T-NOANCHOR-002'").fetchone()[0]
        con.close()
        assert st == "done", "真人拍板后仍拒 = 这 22 张卡被永久锁死"

    def t_gate2_no_user_row_at_all():
        p = fresh(tmp)
        sv_card_no_anchor(p, "T-NOANCHOR-003", hist_user=False)
        try:
            db.advance_task(p, "T-NOANCHOR-003", to="done", owner="w1", session_id=SID)
        except db.NawabanError:
            return
        raise AssertionError("一条 user 行都没有还能 done")

    def anchored_card(p: Path, tid: str, *, verdict_at: int, anchor_at: int = 2000) -> None:
        """造一张**带锚点**的历史卡,拍板行时间可精确指定(不靠 sleep,同秒边界才测得准)。"""
        db.import_task(
            p, task_id=tid, title="带锚点历史卡:测同秒边界", status="staging-verified",
            waiting_on="decision", created_at=1000,
            refs=[{"kind": "acceptance_run", "value": "run://old", "created_at": 1000}],
            events=[{"kind": "status_change", "body": "in_progress→staging-verified",
                     "author": "w1", "created_at": anchor_at}],
            decisions=[{"question": "能 done 吗", "verdict": "能", "decided_by": "user",
                        "created_at": verdict_at,
                        "provenance": {"source": "import", "file": f"{tid}.md", "line": 9,
                                       "raw": "旧卡原文"}}],
        )

    def decide_at(p: Path, tid: str, at: int) -> None:
        """落一条**运行时**真人拍板行(provenance IS NULL),时间戳精确可控。

        控时靠临时替换 `db._now`(decide 的 created_at 取自它),不手写 SQL、不 sleep。
        """
        orig, os.environ["NAWABAN_DECISION_CHANNEL"] = db._now, "chat"
        db._now = lambda: at
        try:
            db.decide(p, tid, question="能 done 吗", verdict="用户原话:done", decided_by="user")
        finally:
            db._now = orig
            os.environ.pop("NAWABAN_DECISION_CHANNEL", None)

    def t_gate2_same_second_is_not_after():
        """秒级粒度:与锚点**同一秒**的运行时拍板,先后不可分辨 → 不认(fail-closed)。"""
        p = fresh(tmp)
        for tid, at, should_pass in (("T-SAMESEC-001", 2000, False),   # 同秒
                                     ("T-SAMESEC-002", 2001, True),    # 晚 1 秒
                                     ("T-SAMESEC-003", 1999, False)):  # 早 1 秒
            anchored_card(p, tid, verdict_at=1500, anchor_at=2000)     # 卡自带一条历史导入行
            decide_at(p, tid, at)
            if should_pass:
                db.advance_task(p, tid, to="done", owner="w1", session_id=SID)
                continue
            try:
                db.advance_task(p, tid, to="done", owner="w1", session_id=SID)
            except db.NawabanError:
                continue
            raise AssertionError(f"{tid}(拍板@{at} vs 锚点@2000)不该放行")

    def t_gate2_anchored_also_rejects_imported_row():
        """阿搬 2026-08-12 提、采纳:有锚点分支也须 provenance IS NULL,否则是裸时间比对——
        「导入行挡得住」只是粒度巧合(转写锚点完整 ISO vs 导入决策行落午夜)。
        本用例造的正是那个反例:**导入的 user 行晚于锚点**,结构上必须仍拒。"""
        p = fresh(tmp)
        anchored_card(p, "T-IMPLATE-001", verdict_at=3000, anchor_at=2000)   # 导入行晚 1000 秒
        try:
            db.advance_task(p, "T-IMPLATE-001", to="done", owner="w1", session_id=SID)
        except db.NawabanError as e:
            assert "历史导入" in str(e), e
        else:
            raise AssertionError("导入的 user 行只因时间晚于锚点就批了 done = 巧合成立而非结构成立")
        decide_at(p, "T-IMPLATE-001", 3001)      # 现落真人拍板 → 放行(仍不死锁)
        db.advance_task(p, "T-IMPLATE-001", to="done", owner="w1", session_id=SID)

    def t_gate2_anchored_path_unchanged():
        """有锚点的正常卡:锚点前的拍板行不算数,锚点后的算数(回归,不许被本次改动带歪)。"""
        p = fresh(tmp)
        db.create_task(p, task_id="T-ANCHOR-001", title="正常卡:走完整生命周期", context="测试")
        db.claim_task(p, "T-ANCHOR-001", owner="w1", session_id=SID)
        db.start_task(p, "T-ANCHOR-001", owner="w1", session_id=SID)
        os.environ["NAWABAN_DECISION_CHANNEL"] = "chat"
        try:
            db.decide(p, "T-ANCHOR-001", question="翻 sv 之前就问", verdict="用户原话:先做",
                      decided_by="user")
            # created_at 是秒级整数;不睡满 1 秒的话旧拍板与锚点同秒,`created_at>=ts` 会判成
            # 「锚点之后」——秒级粒度洞见卡「已知盲区」,已上报,本用例不靠亚秒精度断言语义。
            time.sleep(1.1)
            db.add_ref(p, "T-ANCHOR-001", kind="acceptance_run", value="run://1")
            db.raise_ask(p, kind="accept", question="T-ANCHOR-001:收下吗?", evidence="run://1",
                         task_ids=["T-ANCHOR-001"], raised_by="w1")  # 入口闸
            db.advance_task(p, "T-ANCHOR-001", to="staging-verified", waiting_on="decision",
                            owner="w1", session_id=SID)
            try:
                db.advance_task(p, "T-ANCHOR-001", to="done", owner="w1", session_id=SID)
            except db.NawabanError:
                pass
            else:
                raise AssertionError("翻 sv 之前的旧拍板行不该算数")
            time.sleep(1.1)   # 拍板须**严格晚于**锚点秒(同秒不可分辨→不认),真机自然满足
            db.decide(p, "T-ANCHOR-001", question="验完了能 done 吗", verdict="用户原话:done",
                      decided_by="user")
        finally:
            os.environ.pop("NAWABAN_DECISION_CHANNEL", None)
        db.advance_task(p, "T-ANCHOR-001", to="done", owner="w1", session_id=SID)
        con = db.connect(p)
        st = con.execute("SELECT status FROM tasks WHERE id='T-ANCHOR-001'").fetchone()[0]
        con.close()
        assert st == "done", "锚点之后的真拍板必须放行"

    for name, fn in [
        ("放行:本 session 无未收尾 claim", t_no_claim),
        ("暗雷回归:claim 自带 status_change 不算干过活", t_status_change_not_substantive),
        ("顶回:有实质事件却没收尾(文案≤500字·点名·给补法)", t_nudge_on_substantive_work),
        ("预算≤2:第三次放行+违规事件恰一条(author=闸)", t_budget_two_then_violation),
        ("违规写入撞锁不挂死(先落盘后写库)", t_violation_write_never_hangs),
        ("多卡顶回文案仍≤500字", t_nudge_text_capped),
        ("收尾后放行", t_pass_after_handoff),
        ("三件套原子:now 缺失整笔拒(零写入)", t_now_required_atomic),
        ("保存闸走 CLI 真路径 + --now 必填", t_artifact_gate_via_cli),
        ("fail-open 四路(无库/无 session/坏 stdin/无板)", t_fail_open),
        ("库定位:从 stdin.cwd 上溯 .foreman/", t_resolve_from_cwd),
        ("闸②无锚点:历史导入的 user 行不算数(拒 done)", t_gate2_no_anchor_rejects_historical_user_row),
        ("闸②无锚点:现落真人拍板可放行(fail-closed≠死锁)", t_gate2_no_anchor_accepts_runtime_verdict),
        ("闸②无锚点:一条 user 行都没有必拒", t_gate2_no_user_row_at_all),
        ("闸②同秒边界:同秒不算「之后」·晚1秒算·早1秒不算", t_gate2_same_second_is_not_after),
        ("闸②有锚点也只认运行时行(导入行晚于锚点仍拒)", t_gate2_anchored_also_rejects_imported_row),
        ("闸②有锚点路径回归:锚点前不算·锚点后算", t_gate2_anchored_path_unchanged),
    ]:
        case(name, fn)

    if FAILED:
        print(f"\n✗ {len(FAILED)} 条失败:{FAILED}")
        return 1
    print("\n✓ 编译闸自检全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
