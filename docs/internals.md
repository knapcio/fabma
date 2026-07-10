# Internals

## Why HTML as the design medium

Watching an AI "use" a design tool is painful: one mid-sized Figma frame
serializes to tens of thousands of tokens of node JSON, every edit
round-trips through plugin calls, and the model still can't see what it made.
The same design as a self-contained HTML/SVG document is a few thousand
tokens, renders deterministically, diffs, and versions. Fabma flips the
medium and keeps the human where they're irreplaceable: taste.

## The format

Every variant is one self-contained HTML document (or HTML wrapping one big
SVG for illustrations): inline `<style>`, imagery as inline SVG/CSS, Google
Fonts links as the only external resource. Consequences:

- The workspace (`~/Fabma`) is plain files — open it in Claude Code and edit
  variants conversationally, version it with git, grep it.
- Previews are sandboxed: iframes without same-origin plus a CSP that blocks
  every network destination except Google Fonts. Generated code can't reach
  the local API.
- A variant costs ~2–8k tokens to read or write, not 20–80k of design-tool
  JSON.

Generation rules (locked brief vs. visual direction, art-direction seeds,
refine takes) live in [server/prompts.js](../server/prompts.js).

## Data model

Project → sessions (chats with an agent) → generations (one round of
variants) → variants (HTML files + pinned comments). A project-level
`messages` array carries the discussions, scoped by `sessionId`. Everything
is JSON + HTML files under `~/Fabma/projects/<id>/` — no database.

## Architecture

```
desktop/main.js       the app: Electron shell hosting the playground server
bin/fabma.js          CLI: headless server · `fabma drop` · `fabma skill`
server/
  index.js            express API + SSE + static UI (localhost only)
  generate.js         job engine: parallel variants, retries, cancel, converts
  prompts.js          prompt templates, art-direction seeds, refine takes
  providers/          claude-cli · codex-cli · anthropic-api
  exporters/          elementor (scoped-CSS embed + template) · svg
  skill.js            the agent skill installers (Claude Code + Codex)
web/                  no-build vanilla frontend (ES modules, SSE)
AGENT.md              the protocol agents read at /agent.md
```

No build step, no telemetry. `npm run smoke` sanity-checks the whole loop
without AI calls. Provider trust model and env allowlisting:
[providers.md](providers.md).
