#!/usr/bin/env python3
"""workos dagview ego regression · graph_data 子图契约。

需求:
  - focus 根 + depends 双向 1-hop + 下游传递
  - max_depth / max_nodes 预算
  - 未知根报错;无 root 仍全图
  - 不依赖 tasks 表新字段
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

from nawaban.board_view import _ego_keep, graph_data  # noqa: E402
from nawaban.db import NawabanError  # noqa: E402


def _fixture() -> Path:
    """A←B, C←A, D←C; Z←B(兄)。

    记法: src depends_on dst ⇒ dst 上游, src 下游。
    """
    fd, name = tempfile.mkstemp(suffix=".db")
    import os
    os.close(fd)
    con = sqlite3.connect(name)
    con.executescript(
        """
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT, status TEXT, waiting_on TEXT,
          owner TEXT, epic TEXT, now TEXT,
          context TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER
        );
        CREATE TABLE task_edges (src TEXT, dst TEXT, kind TEXT, note TEXT);
        """
    )
    tasks = [
        ("A", "root", "open"),
        ("B", "up", "in_progress"),
        ("C", "down1", "open"),
        ("D", "down2", "open"),
        ("Z", "sibling", "open"),
    ]
    con.executemany(
        "INSERT INTO tasks(id,title,status,waiting_on,owner,epic,now,context,created_at)"
        " VALUES(?,?,?,NULL,NULL,'e',NULL,NULL,1)",
        tasks,
    )
    con.executemany(
        "INSERT INTO task_edges(src,dst,kind,note) VALUES(?,?,?,NULL)",
        [
            ("A", "B", "depends_on"),
            ("C", "A", "depends_on"),
            ("D", "C", "depends_on"),
            ("Z", "B", "depends_on"),
        ],
    )
    con.commit()
    con.close()
    return Path(name)


class EgoKeep(unittest.TestCase):
    EDGES = [
        {"src": "A", "dst": "B", "kind": "depends_on"},
        {"src": "C", "dst": "A", "kind": "depends_on"},
        {"src": "D", "dst": "C", "kind": "depends_on"},
        {"src": "Z", "dst": "B", "kind": "depends_on"},
    ]

    def test_happy_depends_bidirectional_and_transitive_down(self):
        keep, meta = _ego_keep("A", self.EDGES, max_depth=8, max_nodes=80)
        self.assertEqual(keep, {"A", "B", "C", "D"})
        self.assertEqual(meta["upstream"], 1)
        self.assertEqual(meta["downstream"], 2)
        self.assertFalse(meta["truncated"])
        self.assertNotIn("Z", keep)

    def test_max_depth_cuts_down_chain(self):
        keep, meta = _ego_keep("A", self.EDGES, max_depth=1, max_nodes=80)
        self.assertEqual(keep, {"A", "B", "C"})
        self.assertTrue(meta["truncated"])
        self.assertNotIn("D", keep)

    def test_max_nodes_prefers_downstream(self):
        keep, meta = _ego_keep("A", self.EDGES, max_depth=8, max_nodes=2)
        self.assertEqual(keep, {"A", "C"})
        self.assertTrue(meta["truncated"])

    def test_isolated_root(self):
        keep, meta = _ego_keep("lonely", [], max_depth=8, max_nodes=80)
        self.assertEqual(keep, {"lonely"})
        self.assertEqual(meta["downstream"], 0)
        self.assertFalse(meta["truncated"])


class GraphDataEgo(unittest.TestCase):
    def setUp(self):
        self.path = _fixture()

    def tearDown(self):
        self.path.unlink(missing_ok=True)

    def test_full_graph_no_root(self):
        g = graph_data(self.path)
        self.assertEqual(g["stats"]["total"], 5)
        self.assertIsNone(g["focus"])
        self.assertEqual(len(g["nodes"]), 5)

    def test_focus_subgraph_fields_unchanged(self):
        g = graph_data(self.path, root="A")
        ids = {n["id"] for n in g["nodes"]}
        self.assertEqual(ids, {"A", "B", "C", "D"})
        self.assertEqual(g["focus"]["root"], "A")
        root = next(n for n in g["nodes"] if n["id"] == "A")
        self.assertTrue(root["is_root"])
        # 投影字段,不是 tasks 表列
        self.assertIn("role", root)
        self.assertIn("flags", root)
        self.assertNotIn("success", root)

    def test_unknown_root(self):
        with self.assertRaises(NawabanError):
            graph_data(self.path, root="NOPE")

    def test_sibling_not_pulled_via_upstream(self):
        ids = {n["id"] for n in graph_data(self.path, root="A")["nodes"]}
        self.assertNotIn("Z", ids)

    def test_links_only_inside_keep(self):
        g = graph_data(self.path, root="A")
        ids = {n["id"] for n in g["nodes"]}
        for l in g["links"]:
            self.assertIn(l["source"], ids)
            self.assertIn(l["target"], ids)
        kinds = {l["kind"] for l in g["links"]}
        self.assertIn("depends_on", kinds)
        self.assertEqual(kinds, {"depends_on"})


if __name__ == "__main__":
    unittest.main()
