# claude-plugins

Claude Code plugins by Alan Colón.

## Install

```
/plugin marketplace add alancnet/claude-plugins
/plugin install design@alancnet
```

## Plugins

### design

Design HTML/CSS with Claude in a live browser page. A local server injects a floating
overlay toolbar into your design: **click the element you mean** or **rewrite text in
place**, and each pick reaches Claude as an event, so "make *this* bigger" is never
ambiguous. Claude edits the files, refreshes the page, and commits each change.

| skill | what it does |
|---|---|
| `/design:open` | serve the design, give you the link, and listen for your picks and edits |
| `/design:resume` | start listening again after a pause, or take over from another chat |
| `/design:pick` | ask you to point at one element when a request is ambiguous |
| `/design:inspect` | flash an element, read computed styles, run JS in the live page |
| `/design:screenshot` | capture the page or one element, for Claude or saved for you |
| `/design:stop` | stop listening, or shut the server down |

You rarely need to type these — "show me this design in the browser" starts a session.
Zero dependencies; requires Node.js. Screenshots need Chrome's
`chrome://flags/#canvas-draw-element` flag (there is an approximate fallback without it).

### Upgrading from `web-designer` 1.x

The plugin was renamed. Run `/plugin uninstall web-designer@alancnet`, then
`/plugin install design@alancnet`.
