---
name: pick
description: Ask the user to point at a specific element in the live design page and get back its selector, text, HTML, and size — for resolving "which one?" mid-conversation instead of guessing. Use when a request about the design is ambiguous ("that button", "the second card", "this section"), or when the user offers to "show you" or "point at it".
---

# design:pick — have the user point at the element

```bash
WD=<this skill's base directory>/../../scripts/web-designer   # resolve to an absolute path
```

The CLI lives in the plugin's `scripts/` folder, two levels up from this SKILL.md. Run it
from the project root, where `.web-design.json` lives. If `$WD status` exits 3 (not
running), start a session with `/design:open` first.

```bash
$WD mode element                             # switch their toolbar into element-picking
$WD wait --type element.selected --timeout 300 --brief   # Bash run_in_background: true
```

Tell the user in one line: *"Click the element you mean (or drag a box around it)."* Then
wait. The event carries `selector`, `tag`, `id`, `classes`, `attributes`, `text`, `html`,
`rect`, and `via` (`click` or `marquee` — a drag selects the closest common ancestor).

- If they also type into the request box, an `element.request` follows with their words in
  `request` — use `wait --type element.selected,element.request` to catch either.
- `--peek` reads the matching event without consuming it, so a running `poll` still sees it.
- Confirm the other way round with `$WD highlight '<selector>'` — it scrolls to and flashes
  the element so they can say "yes, that one".
- `wait` exits 2 on timeout and 4 if no page is connected (send them the `$WD url` link).

If a `/design:open` loop is already polling, skip `wait`: the selection rides along with
their next request anyway. Just ask them to click it and describe the change.
