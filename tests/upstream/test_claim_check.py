"""Claim diagnostics must inspect the selected database without blocking claims."""
from __future__ import annotations

import contextlib
import io
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from nawaban import claim_check, db  # noqa: E402

CHECK = ROOT / 'nawaban/claim_check.py'


class ClaimCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='workos-claim-check-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.selected = self.root / 'external/selected.sqlite'
        db.init_db(self.selected)
        db.create_task(self.selected, task_id='OTHER', title='Other work', touches=['src/code.py'])
        db.claim_task(self.selected, 'OTHER', owner='audit:other', session_id='audit-other')

    def run_check(self, *args, cwd=None):
        env = dict(os.environ, NAWABAN_OWNER='audit:current', HOME=str(self.root),
                   NAWABAN_STATE_DIR=str(self.root / 'state'))
        return subprocess.run([sys.executable, str(CHECK), *map(str, args)],
                              cwd=cwd or self.repo, env=env, capture_output=True, text=True, check=False)

    def test_explicit_database_does_not_read_decoy(self):
        db.init_db(self.repo / '.foreman/workos.db')
        result = self.run_check('src/code.py', '--db', self.selected)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('audit:other', result.stdout)
        self.assertIn('🔒', result.stdout)

    def test_public_interface_normalizes_absolute_path(self):
        output = io.StringIO()
        with (patch.object(claim_check, 'owner_liveness', return_value=None),
              contextlib.redirect_stdout(output)):
            claim_check.report_conflicts(self.selected, [str(self.repo / 'src/code.py')],
                                         owner='audit:current', repo=self.repo)
        self.assertIn('🔒 src/code.py', output.getvalue())

    def test_same_owner_does_not_conflict(self):
        result = self.run_check('src/code.py', '--db', self.selected, '--owner', 'audit:other')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('🔒', result.stdout)
        self.assertIn('无别窗占用', result.stdout)

    def test_database_symlink_uses_selected_board(self):
        link = self.repo / 'board-link.sqlite'
        link.symlink_to(self.selected)
        result = self.run_check('src/code.py', '--db', link)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('audit:other', result.stdout)

    def test_corrupt_database_only_warns(self):
        broken = self.root / 'broken.sqlite'
        broken.write_text('not sqlite')
        result = self.run_check('src/code.py', '--db', broken)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('占用未知', result.stdout)

    def test_corrupt_touches_only_warns(self):
        con = db.connect(self.selected)
        try:
            con.execute("UPDATE tasks SET touches='broken' WHERE id='OTHER'")
        finally:
            con.close()
        result = self.run_check('src/code.py', '--db', self.selected)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('不可信锁行', result.stdout)

    def test_missing_database_remains_noop_without_creating_it(self):
        missing = self.root / 'missing.sqlite'
        result = self.run_check('src/code.py', '--db', missing)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no-op', result.stdout)
        self.assertFalse(missing.exists())

    def test_legacy_repo_keeps_cwd_relative_files(self):
        legacy = self.repo / '.foreman/workos.db'
        legacy.parent.mkdir()
        legacy.symlink_to(self.selected)
        nested = self.repo / 'src'
        nested.mkdir()
        result = self.run_check('code.py', '--repo', self.repo, cwd=nested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('🔒 src/code.py', result.stdout)

    def test_explicit_repo_keeps_cwd_relative_files_with_selected_database(self):
        nested = self.repo / 'src'
        nested.mkdir()
        result = self.run_check('code.py', '--repo', self.repo, '--db', self.selected, cwd=nested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('🔒 src/code.py', result.stdout)

    def test_linked_worktree_and_nested_cwd_use_current_tree_root(self):
        main = self.root / 'main'
        gitdir = main / '.git/worktrees/linked'
        gitdir.mkdir(parents=True)
        (self.repo / '.git').write_text(f'gitdir: {gitdir}\n')
        nested = self.repo / 'src'
        nested.mkdir()
        result = self.run_check('src/code.py', '--db', self.selected, cwd=nested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('🔒 src/code.py', result.stdout)

    def test_cli_claim_uses_selected_database_and_keeps_success(self):
        db.init_db(self.repo / '.foreman/workos.db')
        db.create_task(self.selected, task_id='MINE', title='My work', touches=['src/code.py'])
        env = dict(os.environ, NAWABAN_OWNER='audit:current', CLAUDE_CODE_SESSION_ID='audit-current',
                   PYTHONPATH=str(ROOT), HOME=str(self.root),
                   NAWABAN_STATE_DIR=str(self.root / 'state'))
        result = subprocess.run([sys.executable, '-m', 'nawaban', '--db', str(self.selected),
                                 'claim', 'MINE'], cwd=self.repo, env=env,
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('audit:other', result.stdout)
        self.assertIn('✓ claim MINE', result.stdout)
        with contextlib.closing(sqlite3.connect(f'file:{self.selected}?mode=ro', uri=True)) as con:
            row = con.execute("SELECT status,owner FROM tasks WHERE id='MINE'").fetchone()
        self.assertEqual(row, ('claimed', 'audit:current'))

    def test_cli_reports_conflict_before_malformed_legacy_success(self):
        db.create_task(self.selected, task_id='LEGACY', title='Old work', touches=['src/code.py'])
        with contextlib.closing(db.connect(self.selected)) as con:
            con.execute("UPDATE tasks SET success='legacy plain text' WHERE id='LEGACY'")
        env = dict(os.environ, NAWABAN_OWNER='audit:current', CLAUDE_CODE_SESSION_ID='audit-current',
                   PYTHONPATH=str(ROOT), HOME=str(self.root),
                   NAWABAN_STATE_DIR=str(self.root / 'state'))
        result = subprocess.run([sys.executable, '-m', 'nawaban', '--db', str(self.selected),
                                 'claim', 'LEGACY'], cwd=self.repo, env=env,
                                capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('audit:other', result.stdout)
        self.assertIn('🔒', result.stdout)
        self.assertIn('JSONDecodeError', result.stderr)
        with contextlib.closing(sqlite3.connect(f'file:{self.selected}?mode=ro', uri=True)) as con:
            self.assertEqual(con.execute("SELECT status FROM tasks WHERE id='LEGACY'").fetchone(),
                             ('claimed',))


if __name__ == '__main__':
    unittest.main()
