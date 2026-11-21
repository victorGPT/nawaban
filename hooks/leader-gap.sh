#!/bin/sh
python3 -c '
import json, os, sys, time, tempfile
SILENT_UNDER_SECONDS = 30 * 60
CODE_MODE_BACKGROUND_OUTPUT = "poll_event"
d = json.load(sys.stdin)
if d.get("source") == CODE_MODE_BACKGROUND_OUTPUT:
    sys.exit()
sid = d.get("session_id", "x")
f = os.path.join(tempfile.gettempdir(), f"leader-gap-{sid}")
now = time.time()
try: last = float(open(f).read())
except Exception: last = None
open(f, "w").write(str(now))
if last and now - last >= SILENT_UNDER_SECONDS:
    m = int((now - last) // 60); clock = time.strftime("%m-%d %H:%M")
    print(f"距上一句 {m // 60}h{m % 60:02d}m（现在 {clock}）。期间的变化要现查，别凭记忆。")
'
exit 0
