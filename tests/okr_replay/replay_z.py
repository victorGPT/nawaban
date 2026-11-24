import argparse
import json
import math
import re
import sqlite3
import tomllib
from pathlib import Path

ZS = (1.0, 1.64, 1.96)
BOUND_DIGITS = 9
HERE = Path(__file__).parent
E3 = "条件抽取：硬条件和倾向放错档（E3）"
LONG_KEEP = "长对话接着轮保留全部修饰"
E3_TICKETS = ("#1411", "#1413", "#1427", "#1480", "#1509", "#1512", "#1511")
E3_MEASURE_CHANGED_IN = {"#1411": "量法（点名题不计）", "#1427": "量法（判档前过 saidArgs + normalize）", "#1480": "产品 + 金标"}
E3_JUDGED_BY_THE_SPEC = {"#1413", "#1509", "#1512", "#1511"}
LONG_KEEP_TICKETS = ("#1419", "#1462", "#1469")
DRAFT_COMMITTED = {"拒答、说教率（40 条集，取两者高的）", "硬拦（未成年等）每题每次都拦住（范围样例集）", "检索硬条件违反（标准框前 20，闸 10）",
                   "库里没有时冒充", "合规过滤：不合规内容出现在结果里", "偏好规则用例通过率", "每人每周对话轮数比基线（护栏）", "对话到达播放率比基线（护栏）"}
PRODUCTION = re.compile(r"^生产 ")
PEOPLE = re.compile(r"(\d+)/(\d+) 人")
UNSTABLE_IN_A_SOURCE = re.compile(r"[0-9a-f]{7,}|\d+")
TARGET = re.compile(r"(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)")


def wilson(p, n, z):
    if not n:
        return p, p
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, round(centre - half, BOUND_DIGITS)), min(1.0, round(centre + half, BOUND_DIGITS))


def mde(p1, n1, p2, n2, z):
    if not n1 or not n2:
        return 0.0
    pooled = (p1 * n1 + p2 * n2) / (n1 + n2)
    return z * math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))


def n_of(table, kr, source):
    n = table.get(kr)
    if isinstance(n, dict):
        return next((v for k, v in n.items() if k in source), None) if kr != E3 else (n["点名题不计"] if "点名题不计" in source else n["点名题计入"])
    if n == "source":
        m = PEOPLE.search(source)
        return int(m.group(2)) if m else None
    return n


def toward(op, goal, before, after):
    dist = (lambda v: -v) if op in (">=", ">") else (lambda v: v) if op in ("<=", "<") else (lambda v: abs(v - goal))
    return dist(before) - dist(after)


def meets(op, v, goal):
    return {">=": v >= goal, "<=": v <= goal, ">": v > goal, "<": v < goal, "==": v == goal}[op]


def green(op, goal, value, n, z):
    if n is None:
        return meets(op, value, goal)
    lo, hi = (100 * b for b in wilson(value / 100, n, z))
    if op in (">=", ">"):
        return meets(op, lo, goal)
    if op in ("<=", "<"):
        return meets(op, hi, goal)
    return lo <= goal <= hi and value == goal


def verdict(declared, moved, gate):
    if declared == "hold":
        return "不符" if moved <= -gate and moved < 0 else "符合"
    sign = 1 if declared == "toward" else -1
    if sign * moved >= gate and sign * moved > 0:
        return "符合"
    if -sign * moved >= gate and -sign * moved > 0:
        return "不符"
    return "未定"


def declared_as(op, d):
    if d == "=":
        return "hold"
    up = d == "↑"
    return "toward" if up == (op in (">=", ">")) else "away"


def series_key(row):
    return row["def_hash"] or UNSTABLE_IN_A_SOURCE.sub("", row["source"])


def freeze(db, okr, out):
    krs, rows, impacts = load_db(db, okr)
    kept = [r for r in rows if not PRODUCTION.search(r["source"])]
    targets = {k: {"target": v["target"], "unit": v.get("unit", "")} for k, v in krs.items()}
    Path(out).write_text(json.dumps({"krs": targets, "readings": kept, "impacts": impacts}, ensure_ascii=False, indent=1) + "\n")


def load_fixture(path):
    data = json.loads(Path(path).read_text())
    return data["krs"], data["readings"], data["impacts"]


def load_db(db, okr):
    krs = {k["name"]: k for o in tomllib.loads(Path(okr).read_text())["objective"] for k in o.get("kr", [])}
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cols = {c[1] for c in con.execute("PRAGMA table_info(kr_readings)")}
    hashed = "def_hash" if "def_hash" in cols else "'' AS def_hash"
    rows = [dict(r) for r in con.execute(f"SELECT kr, value, as_of, source, measured_at, {hashed} FROM kr_readings"
                                         " WHERE value != '' ORDER BY measured_at, as_of, rowid")]
    impacts = [dict(r) for r in con.execute("SELECT ticket, kr, dir, before, after, declared_at FROM kr_impacts WHERE kr != '' ORDER BY declared_at")]
    return krs, rows, impacts


def target(kr):
    op, goal = TARGET.fullmatch(kr["target"].strip()).groups()
    return op, float(goal)


def number(s):
    return float(str(s).rstrip("%"))


def declarations(krs, rows, impacts, table):
    out = []
    op, goal = target(krs[E3])
    e3 = {i["ticket"]: i for i in impacts if i["kr"] == E3 and i["ticket"] in E3_TICKETS}
    for t in E3_TICKETS:
        i = e3[t]
        before, after = number(i["before"]), number(i["after"])
        n1 = table[E3]["点名题计入"] if t == "#1411" else table[E3]["点名题不计"]
        n2 = table[E3]["点名题不计"]
        out.append(dict(kr="E3", ticket=t, declared=i["dir"], as_=declared_as(op, i["dir"]), before=before, n1=n1, after=after, n2=n2,
                        moved=toward(op, goal, before, after), v1="不判（↓）", note=E3_MEASURE_CHANGED_IN.get(t, "产品"), judged=t in E3_JUDGED_BY_THE_SPEC))
    op, goal = target(krs[LONG_KEEP])
    keep = [r for r in rows if r["kr"] == LONG_KEEP][:2]
    for t in LONG_KEEP_TICKETS:
        i = next(x for x in impacts if x["kr"] == LONG_KEEP and x["ticket"] == t)
        before, after = float(keep[0]["value"]), float(keep[1]["value"])
        out.append(dict(kr="长对话接着轮", ticket=t, declared=i["dir"], as_=declared_as(op, i["dir"]), before=before,
                        n1=n_of(table, LONG_KEEP, keep[0]["source"]), after=after, n2=n_of(table, LONG_KEEP, keep[1]["source"]),
                        moved=toward(op, goal, before, after), v1="不符", note="换评测集 b1-1244 → 1539（SENSOR 下是新序列）", judged=False))
    return out


def one_item(n1, n2):
    return 100 / min(n1, n2)


def e3_chain(impacts, table):
    e3 = {i["ticket"]: i for i in impacts if i["kr"] == E3}
    steps = [e3[t] for t in E3_TICKETS]
    n = lambda t: table[E3]["点名题计入"] if t == "#1411" else table[E3]["点名题不计"]
    return [(number(steps[0]["before"]), n("#1411"))] + [(number(i["after"]), n("")) for i in steps]


def stuck_rounds(op, goal, seq, z, gate=None):
    flagged = []
    for i in range(2, len(seq)):
        (v0, n0), (v1, n1), (v2, n2) = seq[i - 2], seq[i - 1], seq[i]
        if green(op, goal, v2, n2, z):
            continue
        moved = [toward(op, goal, a, b) >= max((gate or (lambda na, nb: 100 * mde(a / 100, na, b / 100, nb, z)))(na, nb) if na and nb else 0, 1e-9)
                 for (a, na), (b, nb) in (((v0, n0), (v1, n1)), ((v1, n1), (v2, n2)))]
        if not any(moved):
            flagged.append(i + 1)
    return flagged


def stuck_now(op, goal, seq):
    flagged = []
    for i in range(2, len(seq)):
        (v0, _), (v1, _), (v2, _) = seq[i - 2], seq[i - 1], seq[i]
        if meets(op, v2, goal):
            continue
        if not any(toward(op, goal, a, b) > 0 for a, b in ((v0, v1), (v1, v2))):
            flagged.append(i + 1)
    return flagged


def current_series(rows):
    if not rows:
        return []
    key = series_key(rows[-1])
    out = []
    for r in reversed(rows):
        if series_key(r) != key:
            break
        out.append(r)
    return out[::-1]


def report(krs, rows, impacts, table_path):
    table = {k: v for k, v in json.loads(Path(table_path).read_text()).items() if not k.startswith("_")}
    by_kr = {}
    for r in rows:
        by_kr.setdefault(r["kr"], []).append(r)
    zs = " | ".join(f"z={z}" for z in ZS)
    out = ["## 一、声明判定（E3 七张 + 长对话接着轮三张）", "",
           f"| KR | 票 | 声明 | 前→后（n） | 往目标走 | MDE {zs} | 一题门 | 现在 | {zs} | 一题门 | 改动 |",
           "|" + "---|" * (9 + 2 * len(ZS))]
    for d in declarations(krs, rows, impacts, table):
        gates = [100 * mde(d["before"] / 100, d["n1"], d["after"] / 100, d["n2"], z) for z in ZS] + [one_item(d["n1"], d["n2"])]
        verdicts = [verdict(d["as_"], d["moved"], g) if d["judged"] else "不判" for g in gates]
        out.append(f"| {d['kr']} | {d['ticket']} | {d['declared']}（{d['as_']}） | {d['before']}（{d['n1']}）→{d['after']}（{d['n2']}） | "
                   f"{d['moved']:+.1f} | " + " | ".join(f"{g:.1f}" for g in gates) + f" | {d['v1']} | " + " | ".join(verdicts) + f" | {d['note']} |")
    out += ["", "## 二、「两轮没动」在第几轮触发（按读数先后数轮）", "",
            f"| KR | 读数（n） | 现在 | {zs} | 一题门（绿灯 z=1.96） |", "|" + "---|" * (4 + len(ZS))]
    op, goal = target(krs[E3])
    chain = e3_chain(impacts, table)
    out.append(f"| E3 声明链（kr_impacts 前后值，SENSOR 前账本吃掉的中间值） | " + "、".join(f"{v:g}（{n}）" for v, n in chain)
               + f" | {stuck_now(op, goal, chain) or '—'} | " + " | ".join(str(stuck_rounds(op, goal, chain, z) or "—") for z in ZS)
               + f" | {stuck_rounds(op, goal, chain, 1.96, one_item) or '—'} |")
    for name, kr in krs.items():
        series = current_series(by_kr.get(name, []))
        if len(series) < 3:
            continue
        op, goal = target(kr)
        seq = [(float(r["value"]), n_of(table, name, r["source"])) for r in series]
        shown = "、".join(f"{v:g}（{n if n else '点'}）" for v, n in seq)
        out.append(f"| {name} | {shown} | {stuck_now(op, goal, seq) or '—'} | " + " | ".join(str(stuck_rounds(op, goal, seq, z) or "—") for z in ZS)
                   + f" | {stuck_rounds(op, goal, seq, 1.96, one_item) or '—'} |")
    out += ["", "## 三、绿灯（每条 KR 最新读数）", "",
            f"| KR | 现值 | n | 目标 | 现在 | " + " | ".join(f"z={z} 区间 / 绿" for z in ZS) + " | 草案 kind |", "|" + "---|" * (6 + len(ZS))]
    tally = {"现在": 0, **{z: 0 for z in ZS}, **{("draft", z): 0 for z in ZS}}
    for name, kr in krs.items():
        rs = by_kr.get(name, [])
        if not rs:
            continue
        op, goal = target(kr)
        last = rs[-1]
        v, n = float(last["value"]), n_of(table, name, last["source"])
        now = meets(op, v, goal)
        tally["现在"] += now
        cells = []
        for z in ZS:
            g = green(op, goal, v, n, z)
            tally[z] += g
            tally[("draft", z)] += now if name in DRAFT_COMMITTED else g
            lo, hi = (100 * b for b in wilson(v / 100, n, z)) if n else (v, v)
            cells.append(f"[{lo:.1f}, {hi:.1f}] {'绿' if g else '未定' if now else '红'}" if n else ("绿" if g else "红"))
        kind = "承诺" if name in DRAFT_COMMITTED else "进取"
        out.append(f"| {name} | {v:g} | {n or '点'} | {kr['target']} | {'绿' if now else '红'} | " + " | ".join(cells) + f" | {kind} |")
    out += ["", f"绿灯数：现在 {tally['现在']}；" + "；".join(f"z={z} 全按进取 {tally[z]}、按草案 kind {tally[('draft', z)]}" for z in ZS), "",
            "## 四、每条 KR 现在的 n、全对（或 0 错）时能不能过线、最少要几题", "",
            f"| KR | 目标 | n | " + " | ".join(f"z={z} 全对界 / 过线 / 最少题数" for z in ZS) + " |", "|" + "---|" * (3 + len(ZS))]
    for name, kr in krs.items():
        op, goal = target(kr)
        unit = kr.get("unit", "")
        rs = by_kr.get(name, [])
        n = n_of(table, name, rs[-1]["source"]) if rs else (table.get(name) if isinstance(table.get(name), int) else None)
        if unit != "%" or op == "==":
            out.append(f"| {name} | {kr['target']}{unit} | {n or '点'} | " + " | ".join("按点值判" for _ in ZS) + " |")
            continue
        if name in table and table[name] is None:
            out.append(f"| {name} | {kr['target']}{unit} | 点 | " + " | ".join("按点值判" for _ in ZS) + " |")
            continue
        best = 1.0 if op in (">=", ">") else 0.0
        cells = []
        for z in ZS:
            need = next(m for m in range(1, 100000) if green(op, goal, 100 * best, m, z))
            if n:
                lo, hi = (100 * b for b in wilson(best, n, z))
                bound = lo if op in (">=", ">") else hi
                cells.append(f"{bound:.1f} / {'能' if n >= need else '不能'} / {need}")
            else:
                cells.append(f"— / — / {need}")
        out.append(f"| {name} | {kr['target']}{unit} | {n or '未知'} | " + " | ".join(cells) + " |")
    return "\n".join(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", default=str(HERE / "ledger.json"))
    ap.add_argument("--n", default=str(HERE / "kr_n.json"))
    ap.add_argument("--db")
    ap.add_argument("--okr")
    ap.add_argument("--freeze")
    a = ap.parse_args()
    if a.freeze:
        freeze(a.db, a.okr, a.freeze)
    else:
        print(report(*(load_db(a.db, a.okr) if a.db else load_fixture(a.fixture)), a.n))
