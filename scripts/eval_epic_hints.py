"""Evaluate module hints against a private, read-only board snapshot.

Keep --output outside the public repository: it contains private task content.
Prepare once, run calibration, freeze the threshold, then run holdout.
"""

import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import cli  # noqa: E402


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def metrics(rows, threshold):
    hinted = [r for r in rows if r["prediction"] is not None and r["score"] >= threshold]
    correct = sum(r["prediction"] == r["expected"] for r in hinted)
    wrong = len(hinted) - correct
    return {"threshold": threshold, "samples": len(rows), "hints": len(hinted),
            "correct": correct, "wrong": wrong, "silent": len(rows) - len(hinted),
            "hit_rate": correct / len(rows), "wrong_per_sample": wrong / len(rows),
            "wrong_per_hint": wrong / len(hinted) if hinted else None}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--split", choices=["prepare", "calibration", "holdout"], required=True)
    ap.add_argument("--replay", action="store_true", help="Rescore saved answers without API calls")
    a = ap.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    snapshot = a.output / "snapshot.json"
    if a.split == "prepare":
        if snapshot.exists():
            ap.error("snapshot already exists; use a new output directory")
        with closing(sqlite3.connect(a.db.resolve().as_uri() + "?mode=ro", uri=True)) as con:
            con.row_factory = sqlite3.Row
            tasks = [dict(r) for r in con.execute(
                "SELECT id,title,origin,success,epic,created_at FROM tasks ORDER BY created_at DESC,id")]
        labeled = [t for t in tasks if t["epic"] and t["epic"].strip()
                   and t["epic"].strip().lower() != "n/a"]
        sample = random.Random(20260917).sample(sorted(labeled, key=lambda t: t["id"]), 120)
        excluded = {t["id"] for t in sample}
        titles = {t["title"] for t in sample}
        # Keep the catalog of module names, but hide every evaluation title.
        rows = [(t["epic"], t["title"]) for t in labeled
                if t["id"] not in excluded and t["title"] not in titles]
        rows += [(name, "") for name in sorted({t["epic"] for t in labeled})]
        question, names = cli._epic_question(rows)
        data = {"seed": 20260917, "labeled_count": len(labeled), "board_sha256": digest(tasks),
                "question": question, "names": names,
                "calibration": sample[:40], "holdout": sample[40:]}
        snapshot.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        print(json.dumps({"labeled": len(labeled), "modules": len(names),
                          "calibration": 40, "holdout": 80, "snapshot_sha256": digest(data)}))
        return
    if not a.replay and not os.environ.get("TYPESAFE_API_KEY"):
        ap.error("TYPESAFE_API_KEY is required for a live evaluation")
    output = a.output / f"{a.split}.jsonl"
    if output.exists() and not a.replay:
        ap.error("split already evaluated; preserve original evidence")
    data = json.loads(snapshot.read_text())
    question, names = data["question"], data["names"]
    results = []
    if a.replay:
        for line in output.read_text().splitlines():
            row = json.loads(line)
            result = cli._epic_choice(row["answer"], question)
            row.update(prediction=names.get(result[0]) if result else None,
                       score=result[1] if result else 0, invalid_tied_or_unavailable=result is None)
            results.append(row)
    else:
        with output.open("x") as f:
            for i, task in enumerate(data[a.split]):
                state = cli._epic_state(task["title"], task["origin"], json.loads(task["success"] or "null"))
                start = time.monotonic()
                answer = cli._answers(state, {"module": question}).get("module")
                elapsed = time.monotonic() - start
                result = cli._epic_choice(answer, question)
                row = {"id": task["id"], "expected": task["epic"],
                       "prediction": names.get(result[0]) if result else None,
                       "score": result[1] if result else 0,
                       "invalid_tied_or_unavailable": result is None, "answer": answer,
                       "seconds": elapsed, "request_sha256": digest({"state": state, "question": question}),
                       "payload_bytes": len(json.dumps({"state": state, "model": "jev-latest",
                                                           "questions": {"module": question}}).encode())}
                results.append(row)
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                f.flush()
                if (i + 1) % 10 == 0:
                    print(f"{a.split}: {i + 1}/{len(data[a.split])}", flush=True)
    times = sorted(r["seconds"] for r in results)
    summary = {"split": a.split, "model": "jev-latest", "snapshot_sha256": digest(data),
               "question_sha256": digest(question), "options": len(question["criteria"]),
               "unavailable_answers": sum(r["answer"] is None for r in results),
               "invalid_tied_or_unavailable": sum(r["invalid_tied_or_unavailable"] for r in results),
               "latency_seconds": {"p50": statistics.median(times),
                                   "p95": times[math.ceil(len(times) * .95) - 1], "max": max(times)},
               "payload_bytes_max": max(r["payload_bytes"] for r in results),
               "metrics": metrics(results, cli._EPIC_HINT_THRESHOLD)}
    if a.split == "calibration":
        summary["thresholds"] = [metrics(results, t) for t in [0, .5, .6, .7, .8, .9, .95, .99]]
    suffix = "replay-summary" if a.replay else "summary"
    (a.output / f"{a.split}-{suffix}.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
