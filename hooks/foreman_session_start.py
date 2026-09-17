#!/usr/bin/env python3
"""Foreman SessionStart hook · 新窗口启动时打印活跃任务摘要 + 注册 pane→session(2.1)。

SessionStart hook stdin JSON: {"session_id": "...", "cwd": "/path/to/project"}
退出码始终 0 · 不阻塞会话启动。

2.1(关窗恢复 / 谁做的):
- 每次启动把 `pane → {session, cwd, owner, ts, resume}` upsert 进状态目录下的
  session-registry.json(默认 ~/.local/state/nawaban;NAWABAN_STATE_DIR 优先于 WORKOS_STATE_DIR)。
  新注册表缺失时读 ~/.claude/foreman/session-registry.json;横幅打印 session + resume 命令。
- `--list`:dump 注册表(给恢复时按 pane/cwd 反查 session-id)。
任意失败都吞掉(注册是增强 · 绝不能拖垮会话启动)。
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

_RUNTIME = Path(__file__).resolve().parents[1] / "nawaban"
_STATE = Path(os.environ.get("NAWABAN_STATE_DIR") or os.environ.get("WORKOS_STATE_DIR")
              or Path.home() / ".local/state/nawaban").expanduser()
_REGISTRY = _STATE / "session-registry.json"
_LEGACY_REGISTRY = Path.home() / ".claude/foreman/session-registry.json"
_LEGACY_STATE = Path.home() / ".claude/state"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db as _wdb  # noqa: E402
try:  # 只有旧 md 卡路径用它;缺 PyYAML 时开工横幅照常出,跳过 md 卡
    from nawaban.foreman_card import CardError, guard_problems, load_card  # noqa: E402
except ImportError:
    load_card = None


def _tmux_owner(pane: str) -> str | None:
    """tmux pane → 'session:window' owner(如 ac/main:w3)· 非 tmux / 失败返 None。"""
    if not pane:
        return None
    try:
        out = subprocess.run(
            ["tmux", "display-message", "-t", pane, "-p", "#S:#W"],
            capture_output=True, text=True, timeout=2,
        )
        owner = out.stdout.strip()
        return owner or None
    except Exception:
        return None


def _register_session(session_id: str, cwd: str) -> tuple[str, str] | None:
    """把本窗口 pane→session 写进注册表(latest-per-pane)· 返 (owner, session) 供横幅显示。

    全程吞错:注册是增强,失败不该影响会话启动 / 任务摘要。
    """
    if not session_id:
        return None
    pane = os.environ.get("TMUX_PANE") or ""
    key = pane or f"no-tmux:{session_id[:8]}"  # 非 tmux 用 session 前缀兜底唯一键
    # owner 与 foreman_guard.py 同款派生:tmux 用 #S:#W(可读),非 tmux 用 ac:<sid8>(稳定不漂)。
    # claim 建卡时写这个字符串 → guard 认得自己的卡(2026-07-04 · tmux/非 tmux 统一)。
    owner = os.environ.get("FOREMAN_OWNER") or _tmux_owner(pane) or f"ac:{session_id[:8]}"
    try:
        reg: dict = {}
        source = _REGISTRY if _REGISTRY.is_file() else _LEGACY_REGISTRY
        if source.is_file():
            try:
                reg = json.loads(source.read_text(encoding="utf-8"))
            except Exception:
                reg = {}
        reg[key] = {
            "session": session_id,
            "cwd": cwd,
            "owner": owner,
            "ts": datetime.now().isoformat(timespec="seconds"),
            "resume": f"claude --resume {session_id}",
        }
        _REGISTRY.parent.mkdir(parents=True, exist_ok=True)
        _REGISTRY.write_text(json.dumps(reg, ensure_ascii=False, indent=2), encoding="utf-8")
        return owner, session_id
    except Exception:
        return owner, session_id  # 写失败也照样显示本窗 owner · 至少这次能恢复


def _print_registry() -> int:
    """--list:dump 注册表 · 给关窗恢复时按 pane/cwd/时间反查 session-id。"""
    source = _REGISTRY if _REGISTRY.is_file() else _LEGACY_REGISTRY
    if not source.is_file():
        print("(session 注册表为空)")
        return 0
    try:
        reg = json.loads(source.read_text(encoding="utf-8"))
    except Exception:
        print("(注册表读取失败)")
        return 0
    rows = sorted(reg.items(), key=lambda kv: kv[1].get("ts", ""), reverse=True)
    print(f"🪟 Foreman session 注册表（{len(rows)} 个窗口 · 新→旧）")
    print("─" * 33)
    for pane, info in rows:
        print(f"{pane:>8}  {info.get('owner','?'):<12}  {info.get('session','?')}")
        print(f"          cwd={info.get('cwd','?')}  @{info.get('ts','?')}")
        print(f"          恢复: {info.get('resume','?')}")
    return 0


def _board_url(port: int = 8813) -> str:
    """板的**可用**地址。写死 127.0.0.1 害过一次:从别的设备打开它指的是那台设备自己。

    优先读端口上真实绑的地址(板可能绑在 tailnet IP 上),没起就给启动命令。
    """
    try:
        out = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                             capture_output=True, text=True, timeout=2).stdout
        m = re.search(r"(\S+):%d \(LISTEN\)" % port, out)
        if m:
            host = m.group(1)
            return f"http://{'127.0.0.1' if host == '*' else host}:{port}/"
    except Exception:
        pass
    return f"板没在跑 → bash {shlex.quote(str(_RUNTIME / 'board-up.sh'))}"


def _inbox_banner(foreman_dir: Path, top: int = 3) -> bool:
    """人侧收件箱摘要(NAWABAN-INBOX-HOOK-001)。返回 True = 已接管人侧段。

    这是**最高频的人侧触点** —— 板你一天开几次,这个每开一个窗口撞一次。
    EEMUA 191 的教训在这里最实:开窗那一刻注意力最贵(你正准备把它投给别的事),
    此刻喷 20 行等于直接从当天预算里扣。只列最旧 top 条,其余压成一个计数 ——
    三条你会读,七条你会跳过。

    同时收口双事实源:原「催办」读 .foreman/tasks/*/active/*.md 按 sv_at 计时,
    而板读 nawaban.db,两边实测差 20+ 张 —— 最高频触点和人侧界面读的是两份数据。
    现在两边同一个 inbox_data() 查询。agent 侧(claim/占用/owner)仍读 md,本卡不碰 CUTOVER。

    fail-soft 是硬要求:库缺失/表没建/装载出错一律安静让路,横幅永远不许挡住 session 启动。
    """
    dbp = _wdb.resolve_db(foreman_dir.parent)
    if not dbp.exists():
        return False
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
        try:
            has = con.execute("SELECT count(*) FROM sqlite_master"
                              " WHERE type='table' AND name='asks'").fetchone()[0]
        finally:
            con.close()
        if not has:
            return False  # 还没迁移的库:安静让路给旧催办段
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from nawaban import board_view
        d = board_view.inbox_data(dbp)
    except Exception:
        print(f"📥 收件箱读取失败(不阻塞开工)· python3 {shlex.quote(str(_RUNTIME / 'board_view.py'))}")
        return True

    flow = f"本周进 {d['flow']['raised_7d']} · 已清 {d['flow']['closed_7d']}"
    if not d["total"]:
        # 空态是常态不是异常(暗驾驶舱)。flow 是活性自证:没有它,一个因上游断了
        # 而恒真的「没事」会把「信号源坏了」伪装成「没事发生」——比没有指示器更坏。
        print(f"📥 收件箱:没有需要你决定的事({flow})")
        return True
    print(f"📥 收件箱:{d['total']} 件事等你 · 最久 {d['oldest_days']} 天({flow})")
    label = {"authorize": "放行", "accept": "验收", "decide": "拍板"}
    items = sorted((a for g in d["groups"] for a in g["items"]),
                   key=lambda x: -x["stalled_days"])
    for a in items[:top]:
        hands = " · 要你亲自点" if a["hands_on"] else ""
        print(f"   · #{a['id']} {a['stalled_days']:.1f}d [{label.get(a['kind'], a['kind'])}] "
              f"{a['question'][:44]}{hands}")
    if d["total"] > top:
        u = _board_url()
        # 指向收件箱页而非板根:板根看不见 ask,曾把人送到唯一找不到这 N 件事的页面
        print(f"   其余 {d['total'] - top} 件 → {u + '?view=inbox' if u.startswith('http') else u}")
    return True


def _context_banner(mine: list[dict], foreman_dir: Path) -> bool:
    """NAWABAN-CONTEXT-LOADER-001 · 分流点(默认关 = 现行 md 横幅**逐字节等价**)。

    开(NAWABAN_CONTEXT_BANNER=1):本窗口 claim 的卡直接打冷启动装载,替代 md 卡片段。
    关(缺省):返回 False,调用方原样走旧分支 —— 这一条是硬验收,零行为变化。

    为什么默认关(2026-08-12 实测):真库是导入时点快照,库里本卡仍 status=open/owner=None
    而 md 里已 claim —— 现在硬接会对着刚 claim 的窗口说「无人认领」,比不接更坏。
    翻开关的动作在 CUTOVER 切换日清单⑤(清库全量重导之后)。

    fail-soft:库缺失/装载出错一律落回 md 片段。横幅永远不许挡住 session 启动。
    """
    if (os.environ.get("NAWABAN_CONTEXT_BANNER") or os.environ.get("WORKOS_CONTEXT_BANNER")) not in ("1", "true", "yes"):
        return False
    dbp = _wdb.resolve_db(foreman_dir.parent)
    if not dbp.exists():
        return False
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from nawaban import context_loader

        budget = max(1500, 8192 // max(1, len(mine)))
        for e in mine:
            print(context_loader.build_context(dbp, e["task_id"], budget=budget))
            _print_kin_summary(e)
        # 判读纪律(CUTOVER 清单⑤ · eval NAWABAN-HANDOFF-EVAL-001 的教训):
        # 事件区是有预算的,视图里那句「还有 N 条未展开」不是装饰——不取全就判「到哪一步」,
        # 正是 A/B eval 里 B 组「下一步」崩到 6/15 的原因。
        print("〔判读纪律〕视图若提示还有未展开事件,判「现在到哪一步 / 下一步做什么」前先取全:"
              "nawaban context <卡号> --events N --budget 24000")
        return True
    except Exception as exc:  # noqa: BLE001  # 边界:hook 里任何异常都不能炸掉开工
        print(f"(装载器不可用,落回 md 片段:{type(exc).__name__}: {exc})")
        return False


def _print_kin_summary(entry: dict) -> None:
    kin = entry.get("kin")
    if not kin:
        return
    parts = []
    if kin["blocked_by"]:
        parts.append(f"被挡 {len(kin['blocked_by'])}")
    if kin["unblocks"]:
        parts.append(f"放开 {len(kin['unblocks'])}")
    if kin["lineage"]["split_from"]:
        parts.append(f"拆自 {kin['lineage']['split_from']}")
    if parts:
        print("    " + " · ".join(parts))


def _warn_dirty_main_tree(cwd: Path, sep: str) -> None:
    """主树脏了就在横幅里说一声(WORKTREE-GATE-001 · 2026-08-20)。

    worktree 闸挡的是 Edit/Write;Bash 里的 `sed -i` / `> 文件` / heredoc 挡不住
    (开放式 shell 正则误伤率太高,不值当)。这一行就是那条缝的兜底:
    把「攒两个月没人发现」变成「每次开窗都看得见」。
    判例 2026-08-20:共享主树积了 220 个未提交文件 + 36 个 stash,
    别的窗口 `git pull --ff-only` 被堵了两天没人知道。
    """
    try:
        git = Path(cwd) / ".git"
        if not git.is_dir():          # 只在主 worktree 报;linked worktree 的 .git 是文件
            return
        out = subprocess.run(
            ["git", "-C", str(cwd), "status", "--porcelain"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return                        # 探测失败绝不阻塞开工
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if not lines:
        return
    untracked = sum(1 for ln in lines if ln.startswith("??"))
    print(f"⚠️  主树脏:{len(lines) - untracked} 改 + {untracked} 未跟踪 —— 别的窗口 git pull 会被堵住")
    print(f"    不是你的活就别 checkout/clean:先 git -C {cwd} status --short 看清楚")
    print(sep)


def _reclaim_stale_owners(foreman_dir: Path) -> None:
    """开窗口时顺手把「主人已经不在」的卡放回可认领(NAWABAN-RECLAIM-STALE-001)。

    挂在这里是因为**收尾这条路结构上堵死**:Stop hook 每轮触发不是 session 结束触发,
    SessionEnd 里没有 foreman 动作,而 `/clear` 与关窗是人的动作 —— agent 没有执行收尾的
    机会。实测装齐了收尾 hook + 两个 wrapup skill,仍有 57% 的卡挂着不存在的窗口。
    开窗口是我们唯一保证会发生的时刻,所以 tick 挂这儿。

    判据只认转录 mtime 与事件时间(运行时 I/O 的副作用,不靠谁自觉),CAS 带快照值,
    回收对当前窗口无害:此刻它还没 claim 任何卡。
    """
    dbp = _wdb.resolve_db(foreman_dir.parent)
    if not dbp.exists():
        return
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from nawaban.reclaim_stale import sweep

        got = sweep(dbp, apply=True)
    except Exception as e:  # noqa: BLE001  边界:hook 崩了会挡住所有窗口开工
        # 不静默 —— 静默失败会让「回收器其实早就没在跑」伪装成「没有僵尸」
        print(f"♻️  回收器没跑成:{type(e).__name__}: {e}(不影响开工)", file=sys.stderr)
        return
    if got:
        print(f"♻️  回收 {len(got)} 张主人已不在的卡 → 退回 open"
              f"(原主与判据在卡的事件里):" +
              " · ".join(t[0] for t in got[:3]) + (" …" if len(got) > 3 else ""))


def main() -> int:
    if "--list" in sys.argv[1:]:
        return _print_registry()

    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    cwd_str = payload.get("cwd") or ""
    session_id = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID") or ""

    # 2.1:注册 pane→session(任意项目都注册 · 关窗恢复不限 foreman)· 横幅打出恢复命令。
    reg = _register_session(session_id, cwd_str)
    owner = None
    if reg is not None:
        owner, sid = reg
        tmux_hint = "" if os.environ.get("TMUX") else "(非 tmux · 稳定不漂)"
        print(f"🪟 本窗口 session: {sid} · owner: {owner} {tmux_hint} · claim 建卡写这个 owner · 恢复: claude --resume {sid}")

    if not cwd_str:
        return 0

    cwd = Path(cwd_str)
    from nawaban import db as _wdb  # sys.path 已在文件头指向本目录
    explicit_db = os.environ.get("NAWABAN_DB") or os.environ.get("WORKOS_DB")
    # Board discovery also finds legacy Markdown-only boards before DB migration.
    foreman_dir = (Path(explicit_db).expanduser().parent if explicit_db
                   else _wdb.foreman_dir(cwd))
    if foreman_dir is None or not foreman_dir.is_dir():
        return 0  # 非 foreman 项目 · 静默退出(session 已注册)

    # 人侧收件箱不依赖 md 卡的存在:md 侧清空(CUTOVER 之后必然发生)时,
    # 若跟着 md 一起提前 return,收件箱会**静默消失** —— 一个会突然不见的指示器,
    # 和一个从不触发的指示器一样坏。所以这两条早退路径上都先打人侧段。
    # CUTOVER(NAWABAN-RETIRE-001 batch1 · 2026-08-29):卡真相在 nawaban.db;md 轨 08-13 冻结,
    # 冻结后 claim 的卡**没有 md 文件**——继续读 glob 就是对着持卡窗口说「我的卡:无」,
    # 「别窗持有 N 张」数的全是 owner 已死的冻结卡。db 在则 db 说了算;db 不在(别的仓
    # 仍走 md 轨)才落回 md 路径。
    entries: list[dict] = []
    used_db = False
    dbp = _wdb.resolve_db(foreman_dir.parent)
    if dbp.exists():
        try:
            import sqlite3
            con = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
            try:
                rows = con.execute(
                    "SELECT id, status, owner, touches, waiting_on FROM tasks"
                    " WHERE status IN ('claimed','in_progress','staging-verified')"
                    " ORDER BY id").fetchall()
                kins = {r[0]: _wdb._kin(con, r[0]) for r in rows if r[2] == owner}  # 只算自己的 · close 前算
            finally:
                con.close()
            for tid, status, towner, touches_j, waiting in rows:
                try:
                    touches = json.loads(touches_j) if touches_j else []
                except Exception:
                    touches = []
                ts = ", ".join(touches[:2]) if touches else "(未声明)"
                if len(touches) > 2:
                    ts += f" +{len(touches) - 2}"
                entries.append({
                    "status": status, "task_id": tid, "owner": towner or "(无)",
                    "touches": ts, "mtime": time.time(), "sv_at": "",
                    "waiting": str(waiting or "").strip(),
                    "kin": kins.get(tid),
                })
            used_db = True
        except Exception as e:  # noqa: BLE001
            # fail-soft 落回 md 路径,横幅不许挡开工;但不静默——静默过一次让 kin 的 bug 隐形了整段横幅
            print(f"⚠️ 板 db 读挂,横幅退回 md 路径:{type(e).__name__}: {e}", file=sys.stderr)
            used_db = False
    if used_db and not entries:
        if not _inbox_banner(foreman_dir):
            print("🏗️  Foreman · 无活跃任务")
        return 0

    tasks_dir = foreman_dir / "tasks"
    if not used_db and not tasks_dir.is_dir():
        if not _inbox_banner(foreman_dir):
            print("🏗️  Foreman · 无活跃任务")
        return 0

    task_files = [] if used_db or load_card is None else list(tasks_dir.glob("*/active/*.md"))
    if not used_db and not task_files:
        if not _inbox_banner(foreman_dir):
            print("🏗️  Foreman · 无活跃任务")
        return 0

    # 收集任务信息(md 路径:仅 db 不存在的仓)
    for tf in sorted(task_files):
        try:
            fm, _ = load_card(tf)
        except CardError as e:
            # fail-loud:坏卡上板可见(旧版 silently continue = 坏卡在看板上隐身)
            entries.append({
                "status": "🧨不可机读", "task_id": tf.stem, "owner": "?",
                "touches": str(e)[:60], "mtime": tf.stat().st_mtime,
                "sv_at": "", "waiting": "",
            })
            continue
        # 「坏卡」判据跟 claim_check 走同一个 guard_problems:能解析但枚举非法的卡
        # 照样会 fail-closed 拦 claim,看板必须报同一件事(否则看板说没事、claim 时才炸)。
        problems = guard_problems(fm)
        if problems:
            entries.append({
                "status": "🧨不可机读", "task_id": str(fm.get("task_id") or tf.stem), "owner": "?",
                "touches": "; ".join(problems)[:80], "mtime": tf.stat().st_mtime,
                "sv_at": "", "waiting": "",
            })
            continue
        status = str(fm.get("status") or "unknown")
        task_id = str(fm.get("task_id") or tf.stem)
        card_owner = str(fm.get("owner") or "(无)")  # 别写回 owner:那是本窗 session owner
        touches = fm.get("touches") or []
        touches_str = ", ".join(touches[:2]) if touches else "(未声明)"
        if len(touches) > 2:
            touches_str += f" +{len(touches) - 2}"
        sv = fm.get("staging_verified_at")  # yaml 会把 ISO 时间解析成 datetime
        entries.append({
            "status": status,
            "task_id": task_id,
            "owner": card_owner,
            "touches": touches_str,
            "mtime": tf.stat().st_mtime,
            "sv_at": sv.isoformat() if hasattr(sv, "isoformat") else str(sv or ""),
            "waiting": str(fm.get("waiting_on") or "").strip(),
        })

    sep = "─" * 33
    print(f"🏗️  Foreman · 当前任务状态（cwd: {cwd_str}）")
    print(sep)
    _warn_dirty_main_tree(cwd, sep)

    # 渐进披露(CTX-ENGINEERING-001 · 2026-08-04):全量列卡曾占 ~13KB/session(80 张卡),
    # 但「别窗有没有占我要改的文件」的真判据是 claim 时跑 foreman_claim_check.py,不是启动时
    # 把整张锁表背一遍。横幅只留当场必须知道的三类,其余按需读卡。
    broken = [e for e in entries if e["status"] == "🧨不可机读"]
    mine = [e for e in entries if e["status"] != "🧨不可机读" and e["owner"] == owner]
    others = [e for e in entries if e["status"] != "🧨不可机读" and e["owner"] != owner]

    for e in broken:  # 坏卡会让 claim fail-closed 拦人,必须当场可见
        print(f"🧨 不可机读 {e['task_id']} · {e['touches']} · 修:foreman_lint.py")
    if mine:
        if not _context_banner(mine, foreman_dir):   # 开关关(默认)→ 落回下面的 md 片段
            for e in mine:
                st = e["status"]
                if st == "staging-verified" and e["waiting"]:
                    st = f"{st}·{e['waiting']}"  # 等待类型可见:decision 才是在等人
                print(f"{f'[{st}]'.ljust(14)} {e['task_id']} · touches: {e['touches']}")
                _print_kin_summary(e)
    else:
        print(f"我的卡({owner or '未注册'}):无 —— 动代码前先 claim")
    if others:
        counts: dict[str, int] = {}
        for e in others:
            counts[e["status"]] = counts.get(e["status"], 0) + 1
        print(f"别窗持有 {len(others)} 张:" + " · ".join(f"{k}×{v}" for k, v in sorted(counts.items())))
    _reclaim_stale_owners(foreman_dir)
    print(sep)
    print(f"共 {len(entries)} 个活跃任务 · 一 pane 一 worktree,claim 时自动提示占用")
    print(f"   收件箱/看板:bash {shlex.quote(str(_RUNTIME / 'board-up.sh'))}(幂等 · 会打印实际可用地址)")

    # 催办(LOOP-FIX · 2026-07-02):staging-verified→done 是全链唯一以「天」计的段
    # (定量摸底:堵 1-7 天占卡生命周期 80%+ · 无人推动)。纯本地扫描,零网络(卡顿体检教训)。
    # 计时锚点优先卡上 staging_verified_at(SKILL 生命周期 7),缺失退化用文件 mtime。
    def _sv_epoch(e: dict) -> float:
        try:
            return datetime.fromisoformat(e["sv_at"]).timestamp()
        except Exception:
            return e["mtime"]

    now = time.time()
    # 人侧段:asks 表在 → 收件箱接管;不在 → 落回下面的 md 催办(未迁移的库/别的仓库)。
    if not _inbox_banner(foreman_dir):
        # 分流(LOOP-TAIL-FASTLANE-001):只催 waiting_on=decision(等用户拍板;缺失视为 decision)。
        # prod/observe/external 各有各的等,催了也 done 不了——混装队列造 alarm fatigue。
        stuck = [
            e for e in entries
            if e["status"] == "staging-verified"
            and e["waiting"] in ("", "decision")
            and now - _sv_epoch(e) > 48 * 3600
        ]
        if stuck:
            print(f"⏰ 催办:{len(stuck)} 张卡等拍板超 48h · 材料在卡 acceptance: · 说「done <ID>」即归档:")
            for e in sorted(stuck, key=_sv_epoch):
                print(f"   · {e['task_id']} 已停 {(now - _sv_epoch(e)) / 86400:.1f} 天 · owner: {e['owner']}")
        parked: dict[str, int] = {}
        for e in entries:
            if e["status"] == "staging-verified" and e["waiting"] not in ("", "decision"):
                parked[e["waiting"]] = parked.get(e["waiting"], 0) + 1
        if parked:
            print("⏳ 其余 verified(不催·各有各的等):"
                  + " · ".join(f"{k}×{v}" for k, v in sorted(parked.items())))

    # stale_check 接电(LOOP-HYGIENE-001):gh 网络调用绝不进启动热路径——日一次后台跑,
    # 横幅带【上一次】的发现;报告文件由后台进程写完整体替换。任何失败吞掉(增强件)。
    try:
        state_dir = _STATE
        report = state_dir / "foreman-stale.txt"
        report_source = report if report.is_file() else _LEGACY_STATE / report.name
        if report_source.is_file():
            txt = report_source.read_text(encoding="utf-8").strip()
            if txt and not txt.startswith("✅"):
                # STALE 是 **agent 卫生问题**(PR 已合但卡没迁),不是需要人 triage 的事。
                # 原来全列 8 行 = 每次开窗都让人扫一遍别人的脏活。只留标题行 + 指针。
                print(txt.splitlines()[0]
                      + f"  → 全表 {report_source}")
        marker = state_dir / "foreman-stale.last"
        marker_source = marker if marker.is_file() else _LEGACY_STATE / marker.name
        today = datetime.now().strftime("%Y-%m-%d")
        if not marker_source.is_file() or marker_source.read_text(encoding="utf-8").strip() != today:
            state_dir.mkdir(parents=True, exist_ok=True)
            marker.write_text(today, encoding="utf-8")
            with open(os.devnull, "rb") as devin, open(os.devnull, "ab") as devout:
                subprocess.Popen(  # 三 fd 全脱离 + 输出经 shell 落文件(fd 纪律 · 无 setsid 命令依赖)
                    ["bash", "-c",
                     # 切换日 2026-08-13:指 DB 版对账器(缺省 dry-run 只报告;
                     # 自动真写 --write 的接电是显式拍板项,不随切换默默激活)
                     f"{shlex.quote(sys.executable)} {shlex.quote(str(_RUNTIME / 'stale_recon.py'))} --repo {shlex.quote(cwd_str)} "
                     f'> {shlex.quote(str(report) + ".tmp")} 2>&1; '
                     f'mv {shlex.quote(str(report) + ".tmp")} {shlex.quote(str(report))}' ],
                    stdin=devin, stdout=devout, stderr=devout, start_new_session=True,
                )
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
