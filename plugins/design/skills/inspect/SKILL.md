---
name: inspect
description: Inspect the live design page as the user sees it — flash an element to confirm "this one?", read computed styles, measure layout, check state after an edit, or drive the toolbar mode — by running JavaScript in the open page. Use when you need real rendered values (font size, colors, widths, overflow, what's on screen) rather than reading the CSS source, or to verify an edit landed.
---

# design:inspect — look inside the live page

```bash
WD=<this skill's base directory>/../../scripts/web-designer   # resolve to an absolute path
```

The CLI lives in the plugin's `scripts/` folder, two levels up from this SKILL.md. Run it
from the project root, where `.web-design.json` lives. If `$WD status` exits 3 (not
running), start a session with `/design:open` first.

```bash
$WD highlight '.card:nth-of-type(2)' [--duration ms]   # scroll to it and flash it
$WD exec "return getComputedStyle(document.querySelector('h1')).fontSize"
$WD exec "return [...document.querySelectorAll('img')].filter(i => !i.complete).map(i => i.src)"
$WD mode off|element|text                              # drive the user's toolbar
$WD status --json                                      # connected pages, ids, queue
```

`exec` runs in the live page with top-level `return` and `await` allowed, and prints the result
as JSON. Return plain data (strings, numbers, arrays, objects) — DOM nodes do not serialise.
Use `--timeout S` for slow work.

- **After an edit, wait for the reload.** `$WD refresh` is polite: the page holds the reload
  until the user is idle (no button down, no selection, no open edit box, a second since they
  last moved). So `refresh` returns before the new page exists — before reading results of an
  edit, check with `exec` that the change is there (e.g. a new class or text).
- **Several pages open?** `status` lists them; pass `--client ID` to `exec`/`highlight`.
  The default is the most recently connected page.
- `fetch`/`curl` of the served files return them without the overlay, so reading the source
  through a tool is never polluted — but it is the source, not the rendered result. Use
  `exec` for the rendered result.
- Exit codes: `3` server not running · `4` no page connected.
