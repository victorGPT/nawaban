"""The optional skill inventory reads an explicit shelf and writes only its output."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class SkillShelfTest(unittest.TestCase):
    def test_inventory_roundtrip_with_isolated_skill_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            shelf = home / 'skills'
            skill = shelf / 'grilling'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: grilling\ndescription: Clarify scope\n---\n')
            output = home / 'generated/inventory.md'
            env = dict(os.environ, HOME=folder, WORKOS_SKILLS_ROOT=str(shelf),
                       WORKOS_SHELF_OUTPUT=str(output))
            script = ROOT / 'scripts/skill_shelf.py'
            for args in ([], ['--check']):
                result = subprocess.run([sys.executable, str(script), *args], env=env,
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('| `grilling` | 本地 | ✓', output.read_text())
            self.assertFalse((home / '.claude').exists())


if __name__ == '__main__':
    unittest.main()
