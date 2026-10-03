---
name: web-designer
description: Serve HTML designs on a local server with an in-page overlay toolbar so the user can point at elements and rewrite text directly in the browser, and Claude can read those picks, edit the files, refresh the page, and take screenshots. Use whenever iterating on HTML/CSS design files with a person watching — "show me this in the browser", "let me pick the element", "which one do you mean", "change that heading", "refresh so I can see it", "screenshot this section".
---

# web-designer — design with the user pointing at the page

The user opens the design in their own browser. A floating toolbar (Next.js dev-overlay
style) lets them **click the element they mean** or **rewrite text in place**. Every pick
arrives here as an event, so "make *this* bigger" stops being ambiguous.

```bash
WD=<this skill's base directory>/scripts/web-designer   # use the absolute path
```

Set `WD` to the `scripts/web-designer` file next to this SKILL.md (the skill's base
directory is given when the skill loads). Run it from the project root — that's where
`.web-design.json` is read and written.

Zero dependencies (Node only). State lives in `.web-design.json` at the project root:
the root directory to serve, the port (reused across sessions), and the running pid.

## Start a session

```bash
$WD start                      # serves designs/ on the remembered port; prints the URL
$WD status                     # pid, port, root, connected pages, queued events
```

`start` is idempotent — it will not launch a second server. Put design files in
`designs/` (override with `--root DIR`, or `"root"` in `.web-design.json`).

**Get the page open — but do not open it yourself.** Print the URL and let the user click
it. No `--launch`, no `xdg-open`, no browser MCP navigation: the user opens the page in
the browser they want, where they can see it. One line is enough:

> Open http://127.0.0.1:PORT/ and you'll see the design with the toolbar on it.

The overlay is injected **only into real browser navigations**. `fetch`, `XMLHttpRequest`
and `curl` get the file untouched, so nothing you read back through a tool is polluted.

## The loop: keep `poll` running

`poll` is the whole interaction model. It blocks until the user **asks for something**,
then prints every queued event and exits. Run it in the background, answer what comes
back, then start it again — so the user can point at the page at any time and be heard.

```bash
$WD poll --timeout 1800          # run this with Bash run_in_background: true
```

**Keep the turn quiet.** A poll batch is the user pointing at the page, not opening a
conversation. Make the change, refresh, re-poll — that is the whole turn. Do not ask them
questions, do not offer options, do not explain what you are about to do or summarise what
you did in more than a line. If a request is ambiguous, pick the most likely reading and
ship it; they are looking at the page and will tell you if it is wrong, which costs them
far less than a question does. Every second spent writing prose is a second the page is
not listening.

- It returns on a **request**: `text.edited` (they saved a text edit) or `element.request`
  (they described a change on a selected element).
- It does **not** return on context events — `element.selected`, `page.open`,
  `page.navigate`, `page.unload`, `mode.changed` — those pile up and ride along in the
  same output, so you can see what led up to the request.
- Anything already queued when a request lands comes out with it, oldest first.
- **One chat listens at a time.** Starting a poll evicts the poll held by any other
  session, which exits 7 there. Pass `--label "<what this chat is>"` so the evicted side
  can say who took over, or `--share` to listen alongside without evicting.
- `--any` returns on any event; `--trigger a,b` picks your own triggers.

Exit codes carry meaning here, so read them:

| exit | meaning | what to do |
|---|---|---|
| 0 | events printed | answer the request, refresh, poll again |
| 2 | the window genuinely expired with nothing requested | poll again — but see *When to stop polling* if this is the second in a row |
| 4 | woken but handed nothing — should not happen | run `$WD log` before saying "nothing came in" |
| 7 | another chat took over listening | **do not restart the poll.** Tell the user this chat stopped listening and who took over; poll again only when they ask this chat to take over |

**Never tell the user nothing arrived on the strength of a timeout alone.** If they say
they submitted something, run `$WD log` — it replays recent events *without* consuming
them, so a request is still visible even if the poll that should have caught it died:

```bash
$WD log --limit 20 --brief      # non-consuming; `flush` and `poll` do consume
```

After a poll returns, in this order:

1. make the change in `designs/`,
2. `$WD refresh` so the user sees it,
3. `$WD done`,
4. put `poll` back in the background — **before** anything else you owe the turn,
5. then commit (see below).

Do not leave the user unheard between turns.

### Commit every change

The user is very likely non-technical and will never think to ask for this, but their work
still has to be saved. Once the poll is back up, commit the edit — and push if the repo has
a remote:

```bash
git add -A && git commit -m "tighten hero spacing" && git push   # push only if a remote exists
```

If the project is not a git repo yet, `git init` it on the first change and commit from
then on — silently, in the same step. No remote means no push; do not go looking for one to
create.

Short, plain commit messages describing the visible change ("bigger card headings", "swap
hero copy") — not "per user request". If the push is rejected or a merge conflict comes up,
resolve it yourself: pull/rebase, keep the design coherent, and carry on. Do not put a git
question in front of the user; they did not ask for a version control conversation.

### When to stop polling

If **two consecutive 30-minute polls expire with no request** (exit 2 twice in a row, an
hour of silence), the user has walked away. Stop polling. Say in one line that you have
stopped listening and that they can say "resume" to pick it back up — the page tells them
the same thing. Leave the server running so their design is still there when they return.
A poll that returns events resets the count.

### The status light

The dot on the toolbar tells the user where they stand, and the state lives on the server
so it survives a page refresh:

| light | meaning |
|---|---|
| 🔴 red | the page has no websocket — server down or unreachable |
| 🟡 yellow | server up, but **nobody is polling**: what they click goes nowhere |
| 🟢 green | an agent is polling and will see what they do |
| ⏳ spinner | an agent is working on their last request (hover shows what) |

Delivering a poll batch flips the light to *working* automatically, so it is never stale
even if you forget. You still owe the user the other half:

```bash
$WD working "restyling the cards"   # optional: refine the note mid-task
$WD done                            # when the change is in and refreshed
```

`done` returns the light to green/yellow. Starting a new poll also clears it, so a crashed
turn cannot leave the page spinning forever.

Red and yellow also raise a notice over the design after a few seconds — "the assistant is
disconnected / has stopped listening", and to say "resume" in the chat — so a user who
comes back to an abandoned page is not left clicking into the void. It clears itself the
moment a poll starts. That is why the phrasing above matters: when you stop polling, tell
them the same word the page tells them.

`wait` and `flush` are still there for one-off use (`wait --type element.selected` to ask
the user to point at something mid-conversation; `flush` to drain without blocking).

## Events

**Requests** — these end a `poll`:

| type | carries |
|---|---|
| `element.request` | `selector`, `tag`, `id`, `classes`, `attributes`, `text`, `html`, `rect`, and `request` — what the user typed about that element |
| `text.edited` | `selector`, `tag`, `oldText`, `newText` — **the page already shows the new text; you still have to write it into the file** |

**Context** — these accumulate and come along with the next request:

| type | carries |
|---|---|
| `element.selected` | the same element fields, plus `via` (`click` / `marquee`) — they picked something but have not said what they want yet |
| `page.open` / `page.navigate` / `page.unload` | `url`, `title`; unload carries `reason` (`unload`, `closed`, `ping-timeout`, …) |
| `text.cancelled` | they discarded a text edit |
| `mode.changed` | `off` / `element` / `text` |
| `page.error` | an uncaught error in the design itself |

A page that dies without saying goodbye still produces `page.unload` — the server treats a
dropped socket as an unload.

## What the toolbar does

- **Element** — hover outlines the element under the cursor (dashed) with a tag/size label;
  click selects it, and **click-and-drag draws a box** that selects the closest common
  ancestor of everything inside. Selecting ends the mode: the pick stays outlined in green
  and a request box opens on it with a focused textarea — the user types what they want
  changed and presses Enter (Shift+Enter for a newline), which sends `element.request`.
  ❌ or Esc deselects and sends nothing.
- **Text** — hover highlights the text node; click makes its parent `contenteditable` with
  the text selected and shows a floating ❌ / ✅. ❌ (or Esc) restores the original text,
  ✅ (or Enter) keeps it and sends `text.edited`. Either way the edit ends.
- Esc leaves a mode. The toolbar is draggable and remembers where it was put.

## Driving the page

```bash
$WD highlight '.card:nth-of-type(2)'   # scroll to it and flash it — "this one?"
$WD exec "return getComputedStyle(document.querySelector('h1')).fontSize"
$WD refresh
```

`exec` runs JS in the live page (top-level `return`, `await` allowed) and prints the JSON
result — good for reading computed styles, measuring, or checking state after an edit.

**`refresh` is polite.** The page holds the reload until the user is still — no button
down, no text selected, no request box or text edit open, and a full second since they last
moved the mouse or typed. Already idle means it reloads at once. So `refresh` returns
before the reload necessarily happens: if you need the *new* page (a screenshot, an `exec`
that reads the result of your edit), give it a moment, or check with `exec` first.

## Screenshots

Rendered **by the page itself** through HTML-in-Canvas, so what you get is exactly what the
user sees — no headless browser, no second render of the page.

```bash
$WD screenshot                          # whole page → your scratchpad; prints the path
$WD screenshot --selector '.hero'       # one element
$WD screenshot --for user --name hero   # → screenshots/ in the project, for the user
```

- `--for agent` (default) writes to this session's scratchpad — for **you** to `Read`.
- `--for user` writes to `screenshots/` — for the **user** to open or keep.
- Also: `--full`, `--scale N`, `--padding N`, `--out PATH`, `--client ID`.

Two requirements, both reported clearly when unmet:

1. **The flag.** Chrome ships the API off. Turn on `chrome://flags/#canvas-draw-element`
   and restart, launch with `--enable-blink-features=CanvasDrawElement`, or (on Linux) put
   that flag in `~/.config/chrome-flags.conf`. The hostname is irrelevant — `127.0.0.1` and
   `localhost` are both secure contexts.
2. **A foreground tab.** The capture works by cloning the target into a `layoutsubtree`
   canvas and drawing it once painted, and a background tab never paints. Content below the
   fold is fine — the whole cloned subtree paints, however tall it is.

Without the flag, either use the `claude-in-chrome` screenshot tool or pass
`--allow-svg-fallback` for an approximate `<foreignObject>` render (same-origin CSS and
custom properties carry over; cross-origin images and fonts may not).

## Everything else

```
$WD stop | restart | url | open [path]    # print links; let the user click them
$WD working [note] | done                 # drive the toolbar's status light
$WD log [--limit N]                       # replay events without consuming them
```

Exit codes: `2` timed out · `3` not running · `4` no page connected / poll woken empty ·
`5` capture failed · `7` poll evicted by another chat.
Server log: `.web-design/server.log`. Everything binds to `127.0.0.1` only.
