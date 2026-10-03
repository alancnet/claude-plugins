# claude-plugins

Claude Code plugins by Alan Colón.

## Install

```
/plugin marketplace add alancnet/claude-plugins
/plugin install web-designer@alancnet
```

## Plugins

### web-designer

Serve HTML/CSS design files on a local server with a floating overlay toolbar. In your own
browser you can **click the element you mean** or **rewrite text in place**; each pick reaches
Claude as an event, so "make *this* bigger" is never ambiguous. Claude edits the files,
refreshes the page, highlights elements to confirm ("this one?"), and takes screenshots.

Zero dependencies — requires Node.js. Ask Claude something like "show me this design in the
browser" to start a session.
