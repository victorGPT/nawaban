#!/usr/bin/env python3
"""NAWABAN-INBOX-RECON-001 · md↔DB 双源对账。

两段各自独立,互不依赖:

  段① 僵尸卡:md 已搬进 done/ 但 DB 仍 active。
       **本脚本不自动关**——done 闸②(db.py:339)要求 waiting_on='decision' 的卡
       必须有一条运行时真人拍板行,那道闸正是防 agent 静默自批的。
       故这里只出清单 + 生成待人执行的批准命令(--emit)。

  段② waiting_on 残留:卡已 done 但 waiting_on 没清。
       纯字段清理,不涉及状态转移,无闸。--apply 直接清,清前自动备份。

用法:
    python3 recon_md_db.py                  # dry-run,两段都只报告
    python3 recon_md_db.py --apply          # 只执行段②(清残留)
    python3 recon_md_db.py --emit <file>    # 段①:把批准命令写到文件,由人过目后执行
"""
from __future__ import annotations

import argparse
import shlex
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db as board_db  # noqa: E402

CLI = Path(__file__).with_name("cli.py")


def _find_db(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    return board_db.resolve_db()


def _md_state(tasks_dir: Path, task_id: str) -> str | None:
    """md 侧该卡在哪个目录:'done' / 'active' / None(没有文件)。"""
    hits = list(tasks_dir.glob(f"*/*/{task_id}.md"))
    if not hits:
        return None
    p = str(hits[0])
    return "done" if "/done/" in p else "active" if "/active/" in p else None


def scan_zombies(con: sqlite3.Connection, tasks_dir: Path) -> list[tuple[str, str, str]]:
    """DB 未 done 但 md 已归档的卡。返回 (id, db_status, waiting_on)。"""
    rows = con.execute(
        "SELECT id, status, COALESCE(waiting_on,'') FROM tasks WHERE status!='done' ORDER BY id"
    ).fetchall()
    return [r for r in rows if _md_state(tasks_dir, r[0]) == "done"]


def scan_residue(con: sqlite3.Connection) -> list[tuple[str, str]]:
    """已 done 但 waiting_on 没清的卡。"""
    return con.execute(
        "SELECT id, waiting_on FROM tasks WHERE status='done' AND waiting_on IS NOT NULL ORDER BY id"
    ).fetchall()


def emit_approval(zombies: list[tuple[str, str, str]], out: Path, selected_db: Path) -> None:
    """段①:生成待人执行的批准命令。--by user 必须由人来跑,agent 不代劳。"""
    lines = [
        "#!/usr/bin/env bash",
        "# NAWABAN-INBOX-RECON-001 · 段① 僵尸卡批准关闭",
        "#",
        "# 这些卡的 md 已在 done/ 归档,但 DB 侧仍挂在你的待拍板队列里。",
        "# done 闸②要求一条运行时真人拍板行,所以这份命令**必须由你执行**——",
        "# agent 代跑 --by user 正是那道闸要防的事。",
        "#",
        "# 执行前请过目清单;有任何一张你认为其实还没办完,把那两行删掉即可。",
        "set -euo pipefail",
        "",
    ]
    # 命令写全,不用 shell 变量:变量里含空格时 zsh 不做 word splitting,
    # 逐行粘贴会 command not found(本脚本作者亲测踩过)。
    w = shlex.join([sys.executable, str(CLI), "--db", str(selected_db.expanduser().resolve())])
    for tid, status, waiting in zombies:
        lines += [
            f"# {tid}  (DB: {status}/{waiting or '-'}  · md: done/)",
            f"{w} decide {shlex.quote(tid)} --by user \\",
            f'  --question "md 侧已归档,DB 侧仍在待拍板队列——确认这件事已经办完了吗?" \\',
            f'  --verdict "已办完,对账关闭(md 侧 done/ 为准)"',
            f"{w} advance {shlex.quote(tid)} --to done",
            "",
        ]
    lines.append('echo "--- 段① 完成 ---"')
    out.write_text("\n".join(lines), encoding="utf-8")
    out.chmod(0o755)


def apply_residue(db: Path, residue: list[tuple[str, str]]) -> None:
    """段②:清 done 卡的 waiting_on 残留。清前备份。"""
    if not residue:
        print("段②:无残留,跳过")
        return
    print(f"段②:备份中…")
    subprocess.run([sys.executable, str(CLI), "--db", str(db), "backup"], check=True)
    con = sqlite3.connect(db)
    try:
        with con:
            con.execute(
                "UPDATE tasks SET waiting_on=NULL WHERE status='done' AND waiting_on IS NOT NULL"
            )
        # 留痕:每张卡记一条 note(task_events 是 append-only,不会被后续覆盖)
        now = int(time.time())
        with con:
            for tid, w in residue:
                con.execute(
                    "INSERT INTO task_events(task_id, session_id, author, kind, body, created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (tid, None, "recon_md_db", "note",
                     f"对账:清掉 done 卡上的 waiting_on 残留(原值 {w})"
                     " —— NAWABAN-INBOX-RECON-001", now),
                )
    finally:
        con.close()
    print(f"段②:已清 {len(residue)} 张")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="md↔DB 双源对账(默认 dry-run)")
    ap.add_argument("--db")
    ap.add_argument("--apply", action="store_true", help="执行段②(清 waiting_on 残留)")
    ap.add_argument("--emit", metavar="FILE", help="段①:把批准命令写到 FILE 供人执行")
    a = ap.parse_args(argv)

    db = _find_db(a.db)
    tasks_dir = db.parent / "tasks"
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        zombies = scan_zombies(con, tasks_dir)
        residue = scan_residue(con)
    finally:
        con.close()

    print(f"库 {db}\n")
    print(f"段① 僵尸卡(md 已归档 · DB 仍 active):{len(zombies)} 张")
    for tid, status, waiting in zombies:
        print(f"   {tid:<42} DB={status}/{waiting or '-'}")
    if zombies and not a.emit:
        print("   → 关闭需真人拍板(done 闸②),用 --emit <file> 生成批准命令")
    print()
    print(f"段② waiting_on 残留(卡已 done · 字段没清):{len(residue)} 张")
    if residue:
        print(f"   {', '.join(t for t, _ in residue[:6])}{' …' if len(residue) > 6 else ''}")
        if not a.apply:
            print("   → --apply 可直接清(纯字段清理,无状态转移)")
    print()

    if a.emit:
        out = Path(a.emit)
        emit_approval(zombies, out, db)
        print(f"段①:批准命令已写到 {out}(过目后执行)")
    if a.apply:
        apply_residue(db, residue)

    # 幂等判据:两段都为空时输出这一行,供验收脚本 grep
    if not zombies and not residue:
        print("对账干净:无僵尸、无残留")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
