---
name: stop
description: Stop listening to the live design page, or shut the design server down entirely (or restart it). Use when the user is done designing, says "stop", "stop listening", "shut it down", "close the design server", or when the server needs a restart after it misbehaves.
---

# design:stop — stop listening or shut the server down

```bash
WD=<this skill's base directory>/../../scripts/web-designer   # resolve to an absolute path
```

The CLI lives in the plugin's `scripts/` folder, two levels up from this SKILL.md. Run it
from the project root, where `.web-design.json` lives. If `$WD status` exits 3 (not
running), start a session with `/design:open` first.

There are two different "stops" — pick the one they mean:

**Stop listening, keep the page up** (the default for "stop" / "pause"). End any background
`poll` you are running and do not start another. The server keeps serving, so their design
stays open; the toolbar light turns yellow and the page shows a notice telling them to say
"resume" — say the same in one line. `/design:resume` picks it back up.

**Shut the server down** (for "shut it down", "I'm done", "close it"):

```bash
$WD stop          # stops the server; open pages go red and show "disconnected"
$WD restart       # stop + start on the same port, when the server misbehaves
$WD status        # confirm: exits 3 once it is down
```

- The port is remembered in `.web-design.json`, so the next `/design:open` comes back on the
  same URL and the user's bookmark keeps working.
- Before shutting down, make sure their last change is committed (see `/design:open`).
- Server log for a misbehaving server: `.web-design/server.log`.
