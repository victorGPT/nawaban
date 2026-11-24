import json
import subprocess
import sys
from pathlib import Path

REPLAY = Path(__file__).parent / "okr_replay"
sys.path.insert(0, str(REPLAY))

import replay_z


def test_the_replay_reruns_from_the_committed_ledger():
    out = subprocess.run([sys.executable, str(REPLAY / "replay_z.py")], capture_output=True, text=True, check=True).stdout
    assert "绿灯数：现在 18；z=1.0 全按进取 13" in out


def test_every_z_reads_e3_stuck_while_it_fell_from_21_6_to_2_1_and_a_one_item_gate_does_not():
    data = json.loads((REPLAY / "ledger.json").read_text())
    table = json.loads((REPLAY / "kr_n.json").read_text())
    chain = replay_z.e3_chain(data["impacts"], table)
    assert [replay_z.stuck_rounds("<=", 3.0, chain, z) for z in replay_z.ZS] == [[8], [3, 4, 5, 6, 7, 8], [3, 4, 5, 6, 7, 8]]
    assert replay_z.stuck_rounds("<=", 3.0, chain, 1.96, replay_z.one_item) == []


def test_the_committed_ledger_holds_no_production_reading():
    data = json.loads((REPLAY / "ledger.json").read_text())
    assert not any(r["source"].startswith("生产 ") for r in data["readings"])
