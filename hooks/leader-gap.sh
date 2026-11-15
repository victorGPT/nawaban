#!/bin/sh
# UserPromptSubmit hook: tell the session how long since the previous prompt; an agent has no clock of its own.
# ponytail: silent under 30 min so it does not add a line to every message.
python3 -c '
import json, os, sys, time, tempfile
d = json.load(sys.stdin)
if d.get("source") == "poll_event": sys.exit()  # Code Mode background output, not the owner speaking
sid = d.get("session_id", "x")
f = os.path.join(tempfile.gettempdir(), f"leader-gap-{sid}")
now = time.time()
try: last = float(open(f).read())
except Exception: last = None
open(f, "w").write(str(now))
if last and now - last >= 1800:
    m = int((now - last) // 60); clock = time.strftime("%m-%d %H:%M")
    print(f"距上一句 {m // 60}h{m % 60:02d}m（现在 {clock}）。期间的变化要现查，别凭记忆。")
'
exit 0
