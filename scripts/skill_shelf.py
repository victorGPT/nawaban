#!/usr/bin/env python3
"""生成上游 skill 货架清单(nawaban references/skill-shelf.md)。

一行一个 skill,用途取自它**自己的** frontmatter `description` —— 不手抄、不转述,
所以 skill 改了自述、这里重跑一次就同步。`--check` 只比对不写,给体检用。

用法:
    python3 "$NAWABAN_HOME/scripts/skill_shelf.py"           # 重新生成
    python3 "$NAWABAN_HOME/scripts/skill_shelf.py" --check   # 漂了就 exit 1
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SHELF_ROOT = Path(os.environ.get("NAWABAN_SKILLS_ROOT", Path.home() / ".agents/skills"))
LOCK = Path(os.environ.get("NAWABAN_SKILLS_LOCK", SHELF_ROOT.parent / ".skill-lock.json"))
NAWABAN_SKILL = Path(__file__).resolve().parents[1] / "skills/nawaban/SKILL.md"
_STATE = Path(os.environ.get("NAWABAN_STATE_DIR", Path.home() / ".local/state/nawaban"))
OUT = Path(os.environ.get("NAWABAN_SHELF_OUTPUT", _STATE / "skill-shelf.md"))


def dispatch_table_names() -> set[str]:
    """已进 dispatch 表的那几个 —— 货架上给它们打 ✓,免得重复评估。"""
    text = NAWABAN_SKILL.read_text(encoding="utf-8")
    sec = text.split("## 外部能力解析")[1].split("\n## ")[0]
    return {name for line in sec.splitlines() if line.startswith("|")
            for name in re.findall(r"`/?([a-z][a-z0-9:-]+)`", line)}


def sources() -> dict[str, str]:
    """skill → 出处。货架是**混装**的:Matt 只占一部分,其余来自十几个仓 + 本地自建。

    这一列不是装饰:`npx skills update` 只覆盖 lock 记着的那些,本地自建的它碰不到;
    反过来,给上游 skill 打的本地补丁(如 code-review 换 codex 执行器)会被更新冲掉。
    """
    if not LOCK.is_file():
        return {}
    entries = json.loads(LOCK.read_text(encoding="utf-8")).get("skills", {})
    return {k: str(v.get("source", "?")) for k, v in entries.items()}


def one_line(desc: str) -> str:
    """自述压成一行:去 YAML 折叠符、并空白、砍到第一个句末、限长。"""
    d = " ".join(desc.replace(">-", " ").split()).strip().strip('"').strip("|").strip()
    # 中文句号切一刀就够了;英文自述常把关键信息放在第二句("Use when …"),别切。
    if (i := d.find("。")) > 30:
        d = d[: i + 1]
    return (d[:157] + "…") if len(d) > 158 else d


def scan() -> list[tuple[str, bool, str, str]]:
    src = sources()
    rows = []
    for d in sorted(SHELF_ROOT.iterdir()):
        f = d / "SKILL.md"
        # 名字带 `.` 的是备份目录(如 foo.before-xxx-20260815),不是货架上的东西
        if not f.is_file() or "." in d.name:
            continue
        fm_match = re.search(r"^---\n(.*?)\n---", f.read_text(encoding="utf-8"), re.S)
        fm = fm_match.group(1) if fm_match else ""
        desc = re.search(r"^description:\s*(.*?)(?=\n[a-z-]+:|\Z)", fm, re.S | re.M)
        origin = src.get(d.name, "")
        rows.append((d.name, "disable-model-invocation: true" in fm,
                     one_line(desc.group(1) if desc else ""),
                     origin.split("/")[0] if origin else "本地"))
    return rows


def render() -> str:
    rows = scan()
    wired = dispatch_table_names()
    by_src: dict[str, int] = {}
    for _, _, _, o in rows:
        by_src[o] = by_src.get(o, 0) + 1
    tally = " · ".join(f"{k} {v}" for k, v in sorted(by_src.items(), key=lambda kv: -kv[1]))
    head = f"""# skill 货架({len(rows)} 个)

**本文件由脚本生成,别手改** —— `python3 "$NAWABAN_HOME/scripts/skill_shelf.py"` 重跑。
用途一栏取自每个 skill 自己的 frontmatter `description`,所以它改了自述这里就跟着变;
手抄一份转述 = 又一个会漂的副本。

怎么用:SKILL.md 第 5 步「表外能力先查上游」时 Read 本文件,而不是 `ls` 一串光名字。
挑中了 → 问用户要不要接进 dispatch 表,别默默造轮子。

**货架是混装的**,别一律当成 Matt 的:{tally}。

- **✓** = 已在 dispatch 表上,绑定了 Loop 的某一步(用法看 SKILL.md 那张表,不用重新评估)
- **手敲** = `disable-model-invocation: true`,只有用户能 `/<name>` 调,agent 调不了
- **来源** = `~/.agents/.skill-lock.json` 记的上游仓;`本地` = lock 里没有,自建或手放的,
  `npx skills update` 碰不到它。反过来,给上游 skill 打的本地补丁会被更新冲掉。

| skill | 来源 | | 用途(它自己的自述) |
|---|---|---|---|
"""
    body = "".join(
        f"| `{n}` | {o} | {'✓' if n in wired else ''}{' 手敲' if dis else ''} | {d} |\n"
        for n, dis, d, o in rows
    )
    return head + body


if __name__ == "__main__":
    new = render()
    if "--check" in sys.argv:
        cur = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if cur != new:
            print(f"货架漂了(盘上 {len(scan())} 个 skill)· 跑 skill_shelf.py 重生成")
            sys.exit(1)
        print(f"OK · 货架 {len(scan())} 个 skill 与盘一致")
    else:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(new, encoding="utf-8")
        print(f"已生成 {OUT} · {len(scan())} 个 skill")
