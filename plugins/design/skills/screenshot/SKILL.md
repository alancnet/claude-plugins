---
name: screenshot
description: Screenshot the live design page or one element exactly as the user sees it — for Claude to check its own work, or saved into the project's screenshots/ folder for the user to keep or share. Use when asked to "screenshot this", "show me how it looks", "capture the hero", "save an image of the page", or to visually verify a design change.
---

# design:screenshot — capture what the user sees

```bash
WD=<this skill's base directory>/../../scripts/web-designer   # resolve to an absolute path
```

The CLI lives in the plugin's `scripts/` folder, two levels up from this SKILL.md. Run it
from the project root, where `.web-design.json` lives. If `$WD status` exits 3 (not
running), start a session with `/design:open` first.

Rendered **by the page itself** through HTML-in-Canvas, so the image is exactly what the user
sees — no headless browser, no second render of the page.

```bash
$WD screenshot                          # whole page → your scratchpad; prints the path
$WD screenshot --selector '.hero'       # one element
$WD screenshot --for user --name hero   # → screenshots/ in the project, for the user
```

- `--for agent` (default) writes to this session's scratchpad — for **you** to `Read`.
- `--for user` writes to `screenshots/` — for the **user** to open or keep. Tell them the path.
- Also: `--full`, `--scale N`, `--padding N`, `--out PATH`, `--client ID`.
- Just ran `refresh`? The reload waits until the user is idle — confirm the new page is up
  (see `/design:inspect`) before capturing, or you will photograph the old one.

Two requirements, both reported clearly when unmet (exit 5):

1. **The flag.** Chrome ships the API off. Turn on `chrome://flags/#canvas-draw-element`
   and restart, launch with `--enable-blink-features=CanvasDrawElement`, or (on Linux) put
   that flag in `~/.config/chrome-flags.conf`. `127.0.0.1` and `localhost` are both secure
   contexts, so the hostname does not matter.
2. **A foreground tab.** The capture clones the target into a `layoutsubtree` canvas and
   draws it once painted, and a background tab never paints. Content below the fold is fine.

Without the flag, use a browser-automation screenshot tool if one is available, or pass
`--allow-svg-fallback` for an approximate `<foreignObject>` render (same-origin CSS and
custom properties carry over; cross-origin images and fonts may not).
