"""Evaluate dependency hints privately using the runtime request protocol.

Prepare a read-only snapshot, run calibration, then run the frozen holdout.
Absent edges are unlabeled, not proven negative dependencies.
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
import subprocess
import sys
import time
import urllib.request
import urllib.error


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban.dependency_hints import (  # noqa: E402
    MODEL, CANDIDATE_RULE, QUESTION, request_payload, scores_from, shortlist,
)
BUDGET = 5.0
SEED = 20260919
THRESHOLDS = [round(.3 + .05 * i, 2) for i in range(12)]
GATE = {"minimum_top1_precision": 0.8, "maximum_negative_hint_rate": 0.1,
        "maximum_seconds": BUDGET}




def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()




def candidates_for(target, tasks):
    # Historical availability is approximate: current project and completion
    # timestamps cannot reconstruct every reopen, cancellation or metadata edit.
    return [t for t in tasks if t["id"] != target["id"]
            and t["project"] == target["project"]
            and t["created_at"] <= target["created_at"]
            and (t["completed_at"] is None or t["completed_at"] >= target["created_at"])]




class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request_worker():
    """The parent kills this read-only request process at the wall-clock budget."""
    payload = sys.stdin.buffer.read()
    request = urllib.request.Request(
        "https://api.typesafe.ai/v1/systemone", data=payload,
        headers={"Authorization": "Bearer " + os.environ["TYPESAFE_API_KEY"],
                 "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=3) as response:
            raw = response.read((1 << 20) + 1)
        if len(raw) > 1 << 20:
            result = {"error": "response_too_large"}
        else:
            result = {"response": json.loads(raw)}
    except urllib.error.HTTPError as exc:
        result = {"error": "HTTPError", "http_status": exc.code,
                  "error_body": exc.read(65536).decode("utf-8", errors="replace")}
    except Exception as exc:
        # Network/API boundary: retain failure class, never headers or credentials.
        result = {"error": type(exc).__name__}
    print(json.dumps(result))




def metrics(rows, threshold):
    successful = [r for r in rows if not r.get("error") and r["seconds"] <= BUDGET
                  and len(r["scores"]) == len(r["candidates"])]
    hits = hints = negative_hints = 0
    positive_cards = sum(bool(r["expected"]) for r in successful)
    negative_cards = len(successful) - positive_cards
    for row in successful:
        selected = sorted(row["scores"], key=lambda key: (-row["scores"][key], key))[0]
        if row["scores"][selected] >= threshold:
            hints += 1
            hits += selected in row["expected"]
            negative_hints += not row["expected"]
    return {"threshold": threshold, "requests": len(rows), "successful_requests": len(successful),
            "request_success_rate": len(successful) / len(rows),
            "positive_cards": positive_cards, "no_dependency_cards": negative_cards,
            "top1_hints": hints, "top1_hits": hits, "unrecorded_hints": hints - hits,
            "top1_precision": hits / hints if hints else None,
            "positive_card_hit_rate": hits / positive_cards if positive_cards else None,
            "no_dependency_hints": negative_hints,
            "no_dependency_hint_rate": negative_hints / negative_cards if negative_cards else None,
            "hint_coverage": hints / len(successful) if successful else None}


def quality_pass(m):
    return (m["top1_precision"] is not None and m["no_dependency_hint_rate"] is not None
            and m["top1_precision"] >= GATE["minimum_top1_precision"]
            and m["no_dependency_hint_rate"] <= GATE["maximum_negative_hint_rate"])


def upstream(task_id, edges):
    """Follow depends_on from a task to all prerequisites, including indirect ones."""
    visited = {task_id}
    pending = list(edges.get(task_id, ()))
    while pending:
        node = pending.pop()
        if node not in visited:
            visited.add(node)
            pending.extend(edges.get(node, ()))
    return visited - {task_id}


def rescore(output, board, threshold):
    """Report a post-hoc owner-selected threshold without rerunning the model."""
    snapshot = json.loads((output / "snapshot.json").read_text())
    with closing(sqlite3.connect(board.resolve().as_uri() + "?mode=ro", uri=True)) as con:
        edges = list(con.execute("SELECT src,dst,created_at FROM task_edges "
                                 "WHERE kind='depends_on' ORDER BY src,dst"))
    graph = {}
    for src, dst, _ in edges:
        graph.setdefault(src, []).append(dst)
    all_rows = []
    splits = {}
    for split in ("calibration", "holdout"):
        rows = [json.loads(line) for line in (output / f"{split}.jsonl").read_text().splitlines()]
        if [r["id"] for r in rows] != [r["id"] for r in snapshot[split]]:
            raise ValueError("Incomplete or mismatched split")
        splits[split] = rows
        all_rows.extend(rows)
    splits["combined"] = all_rows
    summaries = {}
    for split, rows in splits.items():
        measured = metrics(rows, threshold)
        closed_hits = 0
        for row in rows:
            if row.get("error") or row["seconds"] > BUDGET or len(row["scores"]) != len(row["candidates"]):
                continue
            best = min(row["scores"], key=lambda key: (-row["scores"][key], key))
            if row["scores"][best] >= threshold:
                closed_hits += best in upstream(row["id"], graph)
        measured["closure_hits"] = closed_hits
        measured["closure_precision"] = closed_hits / measured["top1_hints"] if measured["top1_hints"] else None
        summaries[split] = measured
    result = {"threshold": threshold, "selection": "owner-selected after examining both splits; not fresh holdout validation",
              "snapshot_sha256": digest(snapshot), "closure_edges_sha256": digest(edges),
              "closure_edges": edges, "closure_as_of_unix": int(time.time()),
              "closure_caveat": "current board edges include later additions; mild temporal leakage",
              "splits": summaries}
    with (output / f"owner-threshold-{threshold:.2f}.json").open("x") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return {key: value for key, value in result.items() if key != "closure_edges"}


def prepare(db, output, exclude_snapshot=None):
    with closing(sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)) as con:
        con.row_factory = sqlite3.Row
        con.execute("BEGIN")
        tasks = [dict(t) for t in con.execute(
            "SELECT id,title,context,success,project,epic,status,created_at,completed_at FROM tasks ORDER BY id")]
        edges = [dict(e) for e in con.execute(
            "SELECT src,dst,created_at FROM task_edges WHERE kind='depends_on' ORDER BY src,dst")]
        events = [dict(e) for e in con.execute("SELECT task_id,created_at FROM task_events ORDER BY created_at")]
    excluded = set()
    if exclude_snapshot:
        previous = json.loads(exclude_snapshot.read_text())
        excluded = {r["id"] for split in ("calibration", "holdout") for r in previous[split]}
    activity = {t["id"]: [t["created_at"]] for t in tasks}
    for event in events:
        activity[event["task_id"]].append(event["created_at"])
    activity = {key: sorted(times) for key, times in activity.items()}
    positive, unlabeled = [], []
    edge_map = {t["id"]: set() for t in tasks}
    for edge in edges:
        edge_map[edge["src"]].add(edge["dst"])
    for task in tasks:
        candidates = candidates_for(task, tasks)
        if not candidates or task["status"] == "cancelled" or task["id"] in excluded:
            continue
        expected = sorted(edge_map[task["id"]] & {t["id"] for t in candidates})
        if not expected and edge_map[task["id"]]:
            continue  # Negative cohort means no recorded outgoing dependency at all.
        chosen = shortlist(task, candidates, activity)
        retained = sorted(set(expected) & {t["id"] for t in chosen})
        row = {"id": task["id"], "candidates": [t["id"] for t in chosen], "expected": expected,
               "candidate_count_before": len(candidates), "retained_expected": retained,
               "discarded_expected": sorted(set(expected) - set(retained))}
        (positive if expected else unlabeled).append(row)
    rng = random.Random(SEED)
    pos = rng.sample(positive, 60)
    neg = rng.sample(unlabeled, 60)
    calibration, holdout = pos[:20] + neg[:20], pos[20:] + neg[20:]
    rng.shuffle(calibration)
    rng.shuffle(holdout)
    data = {"seed": SEED, "model": MODEL, "question": QUESTION, "gate": GATE,
            "thresholds": THRESHOLDS, "candidate_rule": CANDIDATE_RULE,
            "tasks": tasks, "edges": edges, "activity": activity, "excluded_targets": sorted(excluded),
            "positive_pool": len(positive), "unlabeled_pool": len(unlabeled),
            "calibration": calibration, "holdout": holdout}
    with (output / "snapshot.json").open("x") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return {"snapshot_sha256": digest(data), "positive_pool": len(positive),
            "unlabeled_pool": len(unlabeled), "calibration": 40, "holdout": 80}


def evaluate(output, split, replay):
    data = json.loads((output / "snapshot.json").read_text())
    if (data["question"], data["gate"], data["thresholds"], data["model"], data["candidate_rule"]) != (
            QUESTION, GATE, THRESHOLDS, MODEL, CANDIDATE_RULE):
        raise ValueError("Protocol changed since snapshot; prepare a new evaluation")
    decision_path = output / "calibration-decision.json"
    decision = json.loads(decision_path.read_text()) if split == "holdout" else None
    if decision and decision["snapshot_sha256"] != digest(data):
        raise ValueError("Calibration belongs to another snapshot")
    rows_path = output / f"{split}.jsonl"
    if replay:
        rows = [json.loads(line) for line in rows_path.read_text().splitlines()]
    else:
        tasks = {t["id"]: t for t in data["tasks"]}
        rows = []
        with rows_path.open("x") as f:
            for i, sample in enumerate(data[split]):
                payload, names = request_payload(tasks[sample["id"]], [tasks[k] for k in sample["candidates"]])
                encoded = json.dumps(payload).encode()
                start = time.monotonic()
                try:
                    child = subprocess.run([sys.executable, __file__, "--request-worker"], input=encoded,
                                           capture_output=True, check=True, timeout=BUDGET)
                    result = json.loads(child.stdout)
                except subprocess.TimeoutExpired:
                    result = {"error": "wall_clock_timeout"}
                except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
                    result = {"error": type(exc).__name__}
                elapsed = time.monotonic() - start
                row = {**sample, **result, "seconds": elapsed, "payload_bytes": len(encoded),
                       "request_sha256": digest(payload),
                       "scores": scores_from(result.get("response"), names)}
                rows.append(row)
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                f.flush()
                print(f"{split}: {i + 1}/{len(data[split])}, answers={len(row['scores'])}, "
                      f"seconds={elapsed:.3f}, error={row.get('error')}", flush=True)
    if [r["id"] for r in rows] != [r["id"] for r in data[split]]:
        raise ValueError("Incomplete or mismatched split; cannot report a complete evaluation")
    times = sorted(r["seconds"] for r in rows)
    thresholds = [metrics(rows, t) for t in THRESHOLDS]
    if split == "calibration":
        passing = [m for m in thresholds if quality_pass(m)]
        ranked = passing or [m for m in thresholds if m["top1_precision"] is not None]
        selected = max(ranked, key=lambda m: (m["top1_hits"], m["top1_precision"], m["threshold"])) if passing else (
            max(ranked, key=lambda m: (m["top1_precision"], m["top1_hits"], m["threshold"])) if ranked else thresholds[-1])
        decision = {"snapshot_sha256": digest(data), "threshold": selected["threshold"],
                    "calibration_quality_pass": bool(passing),
                    "reason": "most correct top1 hints among passing thresholds; precision then threshold breaks ties"
                    if passing else "no passing threshold; best precision for diagnostic holdout only"}
        if not replay:
            with decision_path.open("x") as f:
                json.dump(decision, f, indent=2)
    measured = metrics(rows, decision["threshold"])
    summary = {"split": split, "model_requested": MODEL, "snapshot_sha256": digest(data),
               "question_sha256": digest(QUESTION), "gate": GATE, "decision": decision,
               "metrics": measured, "requests": len(rows),
               "errors": sum(bool(r.get("error")) for r in rows),
               "incomplete_answers": sum(len(r["scores"]) != len(r["candidates"]) for r in rows),
               "over_budget": sum(r["seconds"] > BUDGET for r in rows),
               "latency_seconds": {"p50": statistics.median(times),
                                   "p95": times[math.ceil(len(times) * .95) - 1], "max": max(times)},
               "candidate_count": {"min": min(len(r["candidates"]) for r in rows),
                                   "median": statistics.median(len(r["candidates"]) for r in rows),
                                   "max": max(len(r["candidates"]) for r in rows)},
               "payload_bytes_max": max(r["payload_bytes"] for r in rows)}
    expected = sum(len(r["expected"]) for r in rows)
    retained = sum(len(r["retained_expected"]) for r in rows)
    positive = sum(bool(r["expected"]) for r in rows)
    summary["candidate_pruning"] = {
        "rule": CANDIDATE_RULE, "eligible_true_edges": expected, "retained_true_edges": retained,
        "discarded_true_edges": expected - retained,
        "edge_recall_ceiling": retained / expected if expected else None,
        "positive_cards": positive, "positive_cards_retaining_any": sum(bool(r["retained_expected"]) for r in rows),
        "card_hit_ceiling": sum(bool(r["retained_expected"]) for r in rows) / positive if positive else None}
    summary["experimental_gate_pass"] = (decision["calibration_quality_pass"] and quality_pass(measured)
                                         and not summary["over_budget"])
    if split == "calibration":
        summary["thresholds"] = thresholds
    suffix = "replay-summary" if replay else "summary"
    (output / f"{split}-{suffix}.json").write_text(json.dumps(summary, indent=2))
    return summary


def main():
    if sys.argv[1:] == ["--request-worker"]:
        request_worker()
        return
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--split", choices=["prepare", "calibration", "holdout", "rescore"], required=True)
    ap.add_argument("--replay", action="store_true")
    ap.add_argument("--exclude-snapshot", type=Path, help="Exclude all previous evaluation targets")
    ap.add_argument("--threshold", type=float, help="Explicit owner-selected post-hoc threshold for rescore")
    a = ap.parse_args()
    repo = Path(__file__).resolve().parents[1]
    if a.output.resolve().is_relative_to(repo):
        ap.error("private evaluation output must be outside the repository")
    if a.split == "prepare" and (a.db is None or a.replay):
        ap.error("prepare requires --db and does not support --replay")
    if a.split == "rescore" and (a.db is None or a.threshold is None or not 0 <= a.threshold <= 1 or a.replay):
        ap.error("rescore requires --db and --threshold in [0,1]; no --replay")
    if a.split in ("calibration", "holdout") and not a.replay and not os.environ.get("TYPESAFE_API_KEY"):
        ap.error("TYPESAFE_API_KEY is required; no requests sent")
    a.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    if a.split == "prepare":
        result = prepare(a.db, a.output, a.exclude_snapshot)
    elif a.split == "rescore":
        result = rescore(a.output, a.db, a.threshold)
    else:
        result = evaluate(a.output, a.split, a.replay)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
