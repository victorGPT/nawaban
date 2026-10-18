"""Exercise the installed command and HTTP consumer with a fresh task database."""
import json
import os
import re
import shutil
import sqlite3
import sys
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


class DistributionTest(unittest.TestCase):
    def test_installed_cli_lifecycle_and_identity(self):
        command = [sys.executable, str(Path(__file__).resolve().parents[2] / 'nawaban/cli.py')]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.foreman/workos.db'
            env = dict(os.environ, NAWABAN_OWNER='ac:distribution',
                       CLAUDE_CODE_SESSION_ID='distribution-test')

            def run(*args, identity=True):
                current = dict(env)
                if not identity:
                    current.pop('NAWABAN_OWNER')
                    current.pop('CLAUDE_CODE_SESSION_ID')
                return subprocess.run([*command, '--db', str(path), *args],
                                      cwd=folder, env=current, capture_output=True, text=True, check=False)

            self.assertEqual(run('init').returncode, 0)
            self.assertEqual(run('create', 'SMOKE-001', '--title', 'A standalone task').returncode, 0)
            self.assertNotEqual(run('claim', 'SMOKE-001', identity=False).returncode, 0)
            self.assertEqual(run('claim', 'SMOKE-001').returncode, 0)
            self.assertEqual(run('start', 'SMOKE-001', '--now', 'Verify migration').returncode, 0)
            with sqlite3.connect(path) as con:
                self.assertEqual(con.execute('select status,owner from tasks').fetchone(),
                                 ('in_progress', 'ac:distribution'))

    def test_distribution_contains_web(self):
        from nawaban.board_view import WEBUI_DIST
        self.assertTrue((WEBUI_DIST / 'index.html').is_file())

    def test_http_serves_the_built_page_and_the_selected_board(self):
        from nawaban import board_view, tracker

        with tempfile.TemporaryDirectory() as folder:
            selected = Path(folder) / 'selected.db'
            decoy = Path(folder) / 'decoy.db'
            for path, task in ((selected, 'HTTP-001'), (decoy, 'DECOY-001')):
                env = dict(os.environ, CLAUDE_CODE_SESSION_ID='distribution-test')
                with patch.dict(os.environ, env):
                    self.assertEqual(tracker.main(['--db', str(path), 'init']), 0)
                    self.assertEqual(tracker.main(['--db', str(path), 'create', task,
                                                   '--title', 'A local task', '--body', '']), 0)
            with patch.object(board_view._Handler, 'db_path', selected), \
                    patch.dict(os.environ, NAWABAN_DB=str(decoy)):
                server = ThreadingHTTPServer(('127.0.0.1', 0), board_view._Handler)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                base = f'http://127.0.0.1:{server.server_port}'
                try:
                    with urllib.request.urlopen(base, timeout=5) as response:
                        html = response.read().decode()
                    self.assertIn('id="root"', html)
                    assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
                    self.assertGreaterEqual(len(assets), 2)
                    for asset in assets:
                        with urllib.request.urlopen(base + asset, timeout=5) as response:
                            self.assertTrue(response.read())
                    with urllib.request.urlopen(base + '/api/board', timeout=5) as response:
                        ids = [t['id'] for c in json.load(response)['columns'] for t in c['tasks']]
                    self.assertEqual(ids, ['HTTP-001'])
                    request = urllib.request.Request(base + '/api/task?id=HTTP-001', data=b'{}',
                                                     method='POST')
                    with self.assertRaises(urllib.error.HTTPError) as refused:
                        urllib.request.urlopen(request, timeout=5)
                    self.assertEqual(refused.exception.code, 405)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
