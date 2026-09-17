#!/usr/bin/env python3
"""Check tracked source against all task IDs from a read-only board snapshot.

Python comment/docstring matches are reported for provenance review. Other matches,
including test fixtures and output strings, fail the check. No database contents
or task IDs are printed; only source locations and aggregate counts are emitted.
"""

import argparse
import ast
import io
from pathlib import Path
import re
import sqlite3
import subprocess
import tokenize


def comment_spans(source, suffix):
    spans = []
    if suffix == ".py":
        spans.extend((token.start, token.end) for token in tokenize.generate_tokens(
            io.StringIO(source).readline) if token.type == tokenize.COMMENT)
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                if (node.body and isinstance(node.body[0], ast.Expr)
                        and isinstance(node.body[0].value, ast.Constant)
                        and isinstance(node.body[0].value.value, str)):
                    doc = node.body[0]
                    # AST columns count UTF-8 bytes; tokenizer columns count characters.
                    lines = source.splitlines()
                    start = len(lines[doc.lineno - 1].encode()[:doc.col_offset].decode())
                    end = len(lines[doc.end_lineno - 1].encode()[:doc.end_col_offset].decode())
                    spans.append(((doc.lineno, start), (doc.end_lineno, end)))
    # Do not infer comments from line prefixes inside strings or other languages.
    # Unknown lexical contexts stay blocking instead of hiding fixture data.
    return spans


def scan(root, task_ids):
    pattern = re.compile(r"(?<![A-Za-z0-9_-])(?:" + "|".join(
        re.escape(task_id) for task_id in sorted(task_ids, key=len, reverse=True)
    ) + r")(?![A-Za-z0-9_-])") if task_ids else re.compile(r"(?!)")
    paths = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"]).decode().split("\0")
    findings = []
    text_files = 0
    for name in paths:
        path = root / name
        if not path.is_file():  # Tracked deletions are absent from the delivered tree.
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        text_files += 1
        spans = comment_spans(source, path.suffix)
        for number, line in enumerate(source.splitlines(), 1):
            for match in pattern.finditer(line):
                provenance = any(start <= (number, match.start())
                                 and (number, match.end()) <= end for start, end in spans)
                findings.append((name, number, "provenance" if provenance else "data"))
    return text_files, findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    con = sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        task_ids = {row[0] for row in con.execute("SELECT id FROM tasks")}
    finally:
        con.close()
    files, findings = scan(root, task_ids)
    for name, line, kind in findings:
        print(f"{kind}: {name}:{line}")
    data = sum(kind == "data" for _, _, kind in findings)
    print(f"Scanned {len(task_ids)} live task IDs across {files} tracked text files: "
          f"{data} data matches; {len(findings) - data} provenance matches to review")
    return int(data != 0)


if __name__ == "__main__":
    raise SystemExit(main())
