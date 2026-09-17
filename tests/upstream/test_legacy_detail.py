"""Legacy text fields remain readable without changing stored task data."""
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from nawaban import board_view, db


class LegacyDetailTest(unittest.TestCase):
    def test_incomplete_window_scan_does_not_report_a_missing_window(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'tasks.db'
            db.init_db(path)
            db.create_task(path, task_id='PARTIAL-001', title='An unscanned worker')
            db.claim_task(path, 'PARTIAL-001', owner='ac:unscanned', session_id='unscanned')
            with patch.object(board_view._Handler, 'db_path', path), \
                    patch.object(board_view, '_transcript_index', return_value=({}, False)):
                server = ThreadingHTTPServer(('127.0.0.1', 0), board_view._Handler)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/api/modules') as response:
                        data = json.load(response)
                    self.assertIsNone(data['tasks'][0]['live'])
                    self.assertFalse(data['liveness']['available'])
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_detail_preserves_unstructured_contract_and_decision_text(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'tasks.db'
            db.init_db(path)
            db.create_task(path, task_id='LEGACY-001', title='Read an old task')
            with sqlite3.connect(path) as con:
                con.execute('update tasks set success=?, constraints_=?',
                            ('Old acceptance text', 'Old scope text'))
                # Model an imported historical row rather than today's structured writer.
                con.execute('insert into task_decisions(task_id,question,verdict,rejected,decided_by,created_at) '
                            'values(?,?,?,?,?,?)',
                            ('LEGACY-001', 'Choose', 'Use A', 'Old unstructured rejection', 'agent:test', 1))
            detail = board_view.task_detail(path, 'LEGACY-001')
            self.assertEqual(detail['success'], 'Old acceptance text')
            self.assertEqual(detail['constraints'], 'Old scope text')
            self.assertEqual(detail['decisions'][0]['rejected'], 'Old unstructured rejection')


if __name__ == '__main__':
    unittest.main()
