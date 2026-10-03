---
name: resume
description: Start listening to the live design page again — after polling stopped from inactivity, after the page shows "the assistant has stopped listening", or to take over listening from another chat. Use when the user says "resume", "I'm back", "keep listening", "take over", or the design toolbar's light is yellow.
---

# design:resume — listen to the page again

```bash
WD=<this skill's base directory>/../../scripts/web-designer   # resolve to an absolute path
```

The CLI lives in the plugin's `scripts/` folder, two levels up from this SKILL.md. Run it
from the project root, where `.web-design.json` lives. If `$WD status` exits 3 (not
running), start a session with `/design:open` first.

```bash
$WD status                                     # server up? pages connected? events queued?
$WD start                                      # only if status exits 3 — idempotent, same port
$WD log --limit 20 --brief                     # what happened while nobody was listening
$WD poll --timeout 1800 --label "<this chat>"  # Bash run_in_background: true
```

- **Check the log first.** Requests made while nobody was polling are still queued and come
  out with the first poll — but read `log` so you can tell the user what you are picking up.
- **Taking over evicts the other chat.** A new poll ends the poll held by any other session
  (it exits 7 there). That is the point of resuming; pass `--label` so the other side can say
  who took over. Use `--share` instead to listen alongside without evicting.
- Starting a poll clears the "stopped listening" notice on the page and turns the light green.

Then run the loop exactly as `/design:open` describes: answer each request, `refresh`, `done`,
re-poll, commit — and keep the turn quiet.
